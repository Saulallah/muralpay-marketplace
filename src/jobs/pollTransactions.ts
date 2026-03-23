import { queryOne, query } from '../db';
import * as mural from '../services/muralPay';
import { matchAndProcessDeposit, syncWithdrawalStatuses } from '../services/paymentProcessor';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const SYNC_INTERVAL_CYCLES = 4;  // sync withdrawals every 4 cycles (2 min)

let cycleCount = 0;

/**
 * Background job that polls Mural for new deposit transactions.
 *
 * This serves as a fallback for webhook delivery failures. The primary
 * mechanism is the Mural webhook (MURAL_ACCOUNT_BALANCE_ACTIVITY).
 */
export function startPollingJob(): void {
  console.log(`[Poll] Starting transaction polling job (interval: ${POLL_INTERVAL_MS}ms)`);
  setInterval(pollOnce, POLL_INTERVAL_MS);
  // Run once on startup after a brief delay
  setTimeout(pollOnce, 5_000);
}

/**
 * Runs a single poll cycle: fetches the 20 most recent transactions from Mural
 * and attempts to match each one to a pending order. Every 4th cycle it also
 * syncs withdrawal statuses so the merchant sees up-to-date payout progress.
 */
async function pollOnce(): Promise<void> {
  cycleCount++;

  try {
    const accountIdRow = await queryOne<{ value: string }>(
      'SELECT value FROM merchant_config WHERE key = $1',
      ['mural_account_id']
    );

    if (!accountIdRow) {
      console.log('[Poll] Merchant account not yet configured, skipping poll.');
      return;
    }

    const accountId = accountIdRow.value;

    // Fetch recent transactions
    const { results: transactions } = await mural.searchTransactions(accountId, 20);

    for (const tx of transactions) {
      await matchAndProcessDeposit(tx);
    }

    // Periodically sync withdrawal statuses
    if (cycleCount % SYNC_INTERVAL_CYCLES === 0) {
      await syncWithdrawalStatuses();
    }
  } catch (err) {
    console.error('[Poll] Error during poll cycle:', err);
  }
}
