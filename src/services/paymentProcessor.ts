import { query, queryOne } from '../db';
import * as mural from './muralPay';

interface Order {
  id: string;
  product_id: string;
  customer_name: string;
  customer_email: string;
  quantity: number;
  unit_price_usdc: string;
  total_usdc: string;
  adjusted_total_usdc: string;
  deposit_wallet_address: string;
  mural_account_id: string;
  status: string;
  transaction_hash: string | null;
  transaction_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Attempt to match an incoming deposit transaction to a pending order.
 *
 * Matching strategy: find a pending order whose adjusted_total_usdc matches
 * the transaction amount within a tolerance of 0.00001 USDC.
 *
 * Pitfalls documented in README:
 * - Two orders with identical amounts (after adjustment) could be mis-matched
 * - Customer sending wrong amount leaves order stuck in pending
 * - Very old pending orders might match a new unrelated deposit
 */
export async function matchAndProcessDeposit(tx: mural.MuralTransaction): Promise<void> {
  // Only process deposit transactions
  if ((tx.transactionDetails as { type: string }).type !== 'deposit') return;

  // Check if we already processed this transaction
  const existing = await queryOne<Order>(
    'SELECT id FROM orders WHERE transaction_id = $1',
    [tx.id]
  );
  if (existing) return;

  const depositAmount = tx.amount.tokenAmount;

  // Find the best matching pending order (closest amount within tolerance)
  const tolerance = 0.00001;
  const orders = await query<Order>(
    `SELECT * FROM orders
     WHERE status = 'pending'
       AND ABS(adjusted_total_usdc::numeric - $1) < $2
     ORDER BY ABS(adjusted_total_usdc::numeric - $1) ASC, created_at ASC
     LIMIT 1`,
    [depositAmount, tolerance]
  );

  if (orders.length === 0) {
    console.log(`[PaymentProcessor] No matching pending order for deposit of ${depositAmount} USDC (tx: ${tx.id})`);
    return;
  }

  const order = orders[0];
  console.log(`[PaymentProcessor] Matched deposit ${tx.id} (${depositAmount} USDC) to order ${order.id}`);

  // Mark the order as paid
  await query(
    `UPDATE orders
     SET status = 'paid', transaction_hash = $1, transaction_id = $2, updated_at = NOW()
     WHERE id = $3`,
    [tx.hash, tx.id, order.id]
  );

  // Trigger withdrawal (fire and don't block)
  initiateWithdrawal(order.id, order.mural_account_id, depositAmount).catch((err) => {
    console.error(`[PaymentProcessor] Withdrawal failed for order ${order.id}:`, err);
  });
}

/**
 * Initiate a USDC → COP withdrawal for a paid order.
 */
export async function initiateWithdrawal(
  orderId: string,
  accountId: string,
  amountUsdc: number
): Promise<void> {
  // Read merchant config
  const counterpartyRow = await queryOne<{ value: string }>('SELECT value FROM merchant_config WHERE key = $1', ['counterparty_id']);
  const payoutMethodRow = await queryOne<{ value: string }>('SELECT value FROM merchant_config WHERE key = $1', ['payout_method_id']);

  if (!counterpartyRow || !payoutMethodRow) {
    throw new Error('Merchant counterparty/payout method not configured. Run startup first.');
  }

  const counterpartyId = counterpartyRow.value;
  const payoutMethodId = payoutMethodRow.value;

  // Update order status
  await query(`UPDATE orders SET status = 'processing_withdrawal', updated_at = NOW() WHERE id = $1`, [orderId]);

  // Create payout request
  let payoutRequest: mural.MuralPayoutRequest;
  try {
    payoutRequest = await mural.createPayoutRequest(
      accountId,
      counterpartyId,
      payoutMethodId,
      amountUsdc,
      `Marketplace order ${orderId}`
    );
  } catch (err) {
    await query(`UPDATE orders SET status = 'paid', updated_at = NOW() WHERE id = $1`, [orderId]);
    throw err;
  }

  // Record the withdrawal
  await query(
    `INSERT INTO withdrawals (order_id, mural_payout_request_id, status, amount_usdc, counterparty_id, payout_method_id)
     VALUES ($1, $2, 'pending', $3, $4, $5)`,
    [orderId, payoutRequest.id, amountUsdc, counterpartyId, payoutMethodId]
  );

  // Execute the payout
  try {
    const executed = await mural.executePayoutRequest(payoutRequest.id);
    const withdrawalStatus = mapPayoutStatus(executed.status);

    await query(
      `UPDATE withdrawals SET status = $1, updated_at = NOW() WHERE mural_payout_request_id = $2`,
      [withdrawalStatus, payoutRequest.id]
    );

    const orderStatus = executed.status === 'EXECUTED' || executed.status === 'PENDING' ? 'withdrawn' : 'processing_withdrawal';
    await query(`UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`, [orderStatus, orderId]);

    console.log(`[PaymentProcessor] Payout ${payoutRequest.id} executed with status ${executed.status} for order ${orderId}`);
  } catch (err) {
    // Payout creation succeeded but execution failed — record it
    await query(
      `UPDATE withdrawals SET status = 'failed', updated_at = NOW() WHERE mural_payout_request_id = $1`,
      [payoutRequest.id]
    );
    await query(`UPDATE orders SET status = 'paid', updated_at = NOW() WHERE id = $1`, [orderId]);
    throw err;
  }
}

/**
 * Maps a Mural payout status to our internal withdrawal status immediately after execution.
 * EXECUTED is still "processing" here because the bank transfer hasn't completed yet.
 */
function mapPayoutStatus(muralStatus: string): string {
  switch (muralStatus) {
    case 'AWAITING_EXECUTION': return 'pending';
    case 'PENDING': return 'processing';
    case 'EXECUTED': return 'processing'; // funds in transit
    case 'FAILED': return 'failed';
    case 'CANCELED': return 'failed';
    default: return 'pending';
  }
}

/**
 * Sync withdrawal statuses from Mural for any in-progress withdrawals.
 */
export async function syncWithdrawalStatuses(): Promise<void> {
  const pendingWithdrawals = await query<{ id: string; mural_payout_request_id: string }>(
    `SELECT id, mural_payout_request_id FROM withdrawals WHERE status IN ('pending', 'processing')`
  );

  for (const w of pendingWithdrawals) {
    try {
      const payout = await mural.getPayoutRequest(w.mural_payout_request_id);
      const newStatus = mapPayoutStatusFinal(payout.status);

      await query(
        `UPDATE withdrawals SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, w.id]
      );

      if (newStatus === 'completed') {
        // Update associated order
        await query(
          `UPDATE orders SET status = 'withdrawn', updated_at = NOW()
           WHERE id = (SELECT order_id FROM withdrawals WHERE id = $1)`,
          [w.id]
        );
      }
    } catch (err) {
      console.error(`[PaymentProcessor] Failed to sync withdrawal ${w.id}:`, err);
    }
  }
}

/**
 * Maps a Mural payout status to our internal withdrawal status during periodic sync.
 * Used by syncWithdrawalStatuses() when polling for updates on in-progress payouts.
 */
function mapPayoutStatusFinal(muralStatus: string): string {
  switch (muralStatus) {
    case 'AWAITING_EXECUTION': return 'pending';
    case 'PENDING':
    case 'EXECUTED': return 'processing';
    case 'FAILED':
    case 'CANCELED': return 'failed';
    default: return 'pending';
  }
}
