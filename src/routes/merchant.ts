import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db';
import { requireAuth } from '../middleware/auth';
import * as mural from '../services/muralPay';
import { syncWithdrawalStatuses } from '../services/paymentProcessor';

const router = Router();

// All merchant routes require auth
router.use(requireAuth);

/**
 * GET /merchant/orders
 * List all orders with their payment status.
 */
router.get('/orders', async (_req: Request, res: Response) => {
  try {
    const orders = await query<{
      id: string;
      status: string;
      customer_name: string;
      customer_email: string;
      product_name: string;
      quantity: number;
      total_usdc: string;
      adjusted_total_usdc: string;
      transaction_hash: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT o.id, o.status, o.customer_name, o.customer_email,
              p.name as product_name, o.quantity,
              o.total_usdc, o.adjusted_total_usdc,
              o.transaction_hash, o.created_at, o.updated_at
       FROM orders o
       JOIN products p ON p.id = o.product_id
       ORDER BY o.created_at DESC`
    );

    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        customer_name: o.customer_name,
        customer_email: o.customer_email,
        product_name: o.product_name,
        quantity: o.quantity,
        total_usdc: parseFloat(o.total_usdc),
        payment_amount_usdc: parseFloat(o.adjusted_total_usdc),
        transaction_hash: o.transaction_hash,
        created_at: o.created_at,
        updated_at: o.updated_at,
      })),
    });
  } catch (err) {
    console.error('[Merchant] GET /orders', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /merchant/orders/:id
 * Get a single order with full detail.
 */
router.get('/orders/:id', async (req: Request, res: Response) => {
  try {
    const order = await queryOne<{
      id: string;
      status: string;
      customer_name: string;
      customer_email: string;
      product_name: string;
      product_id: string;
      quantity: number;
      unit_price_usdc: string;
      total_usdc: string;
      adjusted_total_usdc: string;
      deposit_wallet_address: string;
      mural_account_id: string;
      transaction_hash: string | null;
      transaction_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT o.*, p.name as product_name
       FROM orders o JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // Also fetch withdrawal if exists
    const withdrawal = await queryOne<{
      id: string;
      mural_payout_request_id: string;
      status: string;
      amount_usdc: string;
      created_at: Date;
      updated_at: Date;
    }>('SELECT * FROM withdrawals WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [order.id]);

    res.json({ order, withdrawal });
  } catch (err) {
    console.error('[Merchant] GET /orders/:id', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * GET /merchant/withdrawals
 * List all COP withdrawal statuses.
 * Syncs status from Mural before returning.
 */
router.get('/withdrawals', async (_req: Request, res: Response) => {
  try {
    // Sync status from Mural for pending/processing withdrawals
    await syncWithdrawalStatuses();

    const withdrawals = await query<{
      id: string;
      order_id: string;
      mural_payout_request_id: string;
      status: string;
      amount_usdc: string;
      counterparty_id: string;
      payout_method_id: string;
      created_at: Date;
      updated_at: Date;
      customer_name: string;
    }>(
      `SELECT w.*, o.customer_name
       FROM withdrawals w
       JOIN orders o ON o.id = w.order_id
       ORDER BY w.created_at DESC`
    );

    res.json({
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        order_id: w.order_id,
        mural_payout_request_id: w.mural_payout_request_id,
        status: w.status,
        amount_usdc: parseFloat(w.amount_usdc),
        customer_name: w.customer_name,
        created_at: w.created_at,
        updated_at: w.updated_at,
      })),
    });
  } catch (err) {
    console.error('[Merchant] GET /withdrawals', err);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

/**
 * GET /merchant/withdrawals/:id
 * Get a single withdrawal with live status from Mural.
 */
router.get('/withdrawals/:id', async (req: Request, res: Response) => {
  try {
    const withdrawal = await queryOne<{
      id: string;
      order_id: string;
      mural_payout_request_id: string;
      status: string;
      amount_usdc: string;
      created_at: Date;
      updated_at: Date;
    }>('SELECT * FROM withdrawals WHERE id = $1', [req.params.id]);

    if (!withdrawal) {
      res.status(404).json({ error: 'Withdrawal not found' });
      return;
    }

    // Fetch live status from Mural
    let muralPayout: mural.MuralPayoutRequest | null = null;
    try {
      muralPayout = await mural.getPayoutRequest(withdrawal.mural_payout_request_id);
    } catch {
      // Non-fatal — return what we have
    }

    res.json({
      withdrawal: {
        ...withdrawal,
        amount_usdc: parseFloat(withdrawal.amount_usdc),
      },
      mural_payout_status: muralPayout?.status ?? null,
      mural_payout_details: muralPayout?.payouts ?? null,
    });
  } catch (err) {
    console.error('[Merchant] GET /withdrawals/:id', err);
    res.status(500).json({ error: 'Failed to fetch withdrawal' });
  }
});

/**
 * GET /merchant/account
 * Get the merchant's Mural account info (balance, wallet address).
 */
router.get('/account', async (_req: Request, res: Response) => {
  try {
    const accountIdRow = await queryOne<{ value: string }>(
      'SELECT value FROM merchant_config WHERE key = $1',
      ['mural_account_id']
    );

    if (!accountIdRow) {
      res.status(503).json({ error: 'Merchant account not configured' });
      return;
    }

    const account = await mural.getAccount(accountIdRow.value);
    res.json({ account });
  } catch (err) {
    console.error('[Merchant] GET /account', err);
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

/**
 * GET /merchant/config
 * Get stored merchant configuration (IDs, wallet address).
 */
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ key: string; value: string }>(
      'SELECT key, value FROM merchant_config ORDER BY key'
    );
    const configMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ config: configMap });
  } catch (err) {
    console.error('[Merchant] GET /config', err);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

export default router;
