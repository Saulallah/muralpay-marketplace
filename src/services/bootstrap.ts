import { query, queryOne } from '../db';
import * as mural from './muralPay';
import { config } from '../config';

/**
 * Bootstrap the merchant setup on application startup:
 * 1. Create or retrieve the Mural account
 * 2. Create or retrieve the merchant counterparty (COP bank)
 * 3. Create or retrieve the payout method
 * 4. Register the webhook (if APP_URL is configured)
 */
export async function bootstrapMerchant(): Promise<void> {
  console.log('[Bootstrap] Starting merchant setup...');

  await ensureMuralAccount();
  await ensureCounterpartyAndPayoutMethod();

  if (config.appUrl) {
    await ensureWebhook();
  } else {
    console.log('[Bootstrap] APP_URL not set — skipping webhook registration. Set APP_URL to enable webhooks.');
  }

  console.log('[Bootstrap] Merchant setup complete.');
}

// ─── Mural Account ────────────────────────────────────────────────────────────

/**
 * Finds or creates the merchant's Mural account. Checks the DB first, then looks
 * for an existing API-enabled account in Mural, then creates one if none exists.
 */
async function ensureMuralAccount(): Promise<void> {
  const stored = await queryOne<{ value: string }>(
    'SELECT value FROM merchant_config WHERE key = $1',
    ['mural_account_id']
  );

  if (stored) {
    console.log(`[Bootstrap] Using existing Mural account: ${stored.value}`);
    // Refresh wallet address in case it changed
    await refreshWalletAddress(stored.value);
    return;
  }

  // Check if there's already an account in Mural we can use
  let accounts: mural.MuralAccount[] = [];
  try {
    accounts = await mural.getAccounts();
  } catch (err) {
    console.error('[Bootstrap] Failed to fetch accounts:', err);
  }

  // Prefer the API-enabled "Marketplace Main Account" first, then any API-enabled account
  const existing =
    accounts.find((a) => a.name === 'Marketplace Main Account' && a.isApiEnabled) ??
    accounts.find((a) => a.isApiEnabled);
  if (existing) {
    await saveAccountConfig(existing);
    return;
  }

  // Create a new account
  console.log('[Bootstrap] Creating new Mural account...');
  const account = await mural.createAccount('Marketplace Main Account');
  await saveAccountConfig(account);
}

/**
 * Saves the Mural account ID to the DB. If the account is already ACTIVE, fetches the
 * wallet address immediately. Otherwise polls until the account activates (up to ~60s).
 */
async function saveAccountConfig(account: mural.MuralAccount): Promise<void> {
  await upsertConfig('mural_account_id', account.id);
  console.log(`[Bootstrap] Mural account ${account.id} (status: ${account.status})`);

  if (account.status === 'ACTIVE') {
    await refreshWalletAddress(account.id);
  } else {
    console.log('[Bootstrap] Account is initializing — wallet address will be fetched when active.');
    // Poll until active
    await waitForAccountActive(account.id);
  }
}

/**
 * Polls the Mural API every 5 seconds until the account status becomes ACTIVE,
 * then saves the wallet address. Gives up after maxAttempts (default 12 = ~60s).
 */
async function waitForAccountActive(accountId: string, maxAttempts = 12): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5_000);
    try {
      const account = await mural.getAccount(accountId);
      if (account.status === 'ACTIVE') {
        await refreshWalletAddress(accountId);
        return;
      }
      console.log(`[Bootstrap] Account still initializing (attempt ${i + 1}/${maxAttempts})...`);
    } catch (err) {
      console.error('[Bootstrap] Error checking account status:', err);
    }
  }
  console.warn('[Bootstrap] Account did not become active in time. Wallet address not set.');
}

/**
 * Fetches the account's Polygon wallet address from Mural and saves it to the DB.
 * This wallet address is what customers send USDC to when paying for orders.
 */
async function refreshWalletAddress(accountId: string): Promise<void> {
  try {
    const account = await mural.getAccount(accountId);
    const walletAddr = account.accountDetails?.walletDetails?.walletAddress;
    if (walletAddr) {
      await upsertConfig('wallet_address', walletAddr);
      await upsertConfig('wallet_blockchain', account.accountDetails?.walletDetails?.blockchain ?? 'POLYGON');
      console.log(`[Bootstrap] Wallet address: ${walletAddr}`);
    }
  } catch (err) {
    console.error('[Bootstrap] Failed to refresh wallet address:', err);
  }
}

// ─── Counterparty & Payout Method ────────────────────────────────────────────

/**
 * Ensures the merchant counterparty and COP payout method exist in Mural.
 * Creates them if missing and saves their IDs to the DB. The counterparty represents
 * the merchant as a person; the payout method is their Colombian bank account.
 */
async function ensureCounterpartyAndPayoutMethod(): Promise<void> {
  const cpRow = await queryOne<{ value: string }>(
    'SELECT value FROM merchant_config WHERE key = $1',
    ['counterparty_id']
  );
  const pmRow = await queryOne<{ value: string }>(
    'SELECT value FROM merchant_config WHERE key = $1',
    ['payout_method_id']
  );

  if (cpRow && pmRow) {
    console.log(`[Bootstrap] Using existing counterparty ${cpRow.value} / payout method ${pmRow.value}`);
    return;
  }

  let counterpartyId: string;

  if (cpRow) {
    counterpartyId = cpRow.value;
  } else {
    console.log('[Bootstrap] Creating merchant counterparty (COP bank)...');
    const counterparty = await mural.createCounterparty({
      firstName: config.merchant.firstName,
      lastName: config.merchant.lastName,
      email: config.merchant.email,
      address: config.merchant.address,
      city: config.merchant.city,
      state: config.merchant.state,
      country: config.merchant.country,
      zip: config.merchant.zip,
    });
    counterpartyId = counterparty.id;
    await upsertConfig('counterparty_id', counterpartyId);
    console.log(`[Bootstrap] Created counterparty: ${counterpartyId}`);
  }

  if (!pmRow) {
    console.log('[Bootstrap] Creating COP payout method...');
    const payoutMethod = await mural.createPayoutMethod(counterpartyId, {
      bankId: config.merchant.bankId,
      bankAccountNumber: config.merchant.bankAccountNumber,
      accountType: config.merchant.accountType,
      documentType: config.merchant.documentType,
      documentNumber: config.merchant.documentNumber,
      phoneNumber: config.merchant.phoneNumber,
    });
    await upsertConfig('payout_method_id', payoutMethod.id);
    console.log(`[Bootstrap] Created payout method: ${payoutMethod.id}`);
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Registers a webhook with Mural for deposit and payout events.
 * Checks if a webhook for our URL already exists before creating a new one.
 * Activates the webhook after creation (Mural creates webhooks as DISABLED by default).
 */
async function ensureWebhook(): Promise<void> {
  const webhookUrl = `${config.appUrl}/webhooks/mural`;
  const storedId = await queryOne<{ value: string }>(
    'SELECT value FROM merchant_config WHERE key = $1',
    ['webhook_id']
  );

  if (storedId) {
    console.log(`[Bootstrap] Webhook already registered: ${storedId.value}`);
    return;
  }

  // Check if one already exists for our URL
  try {
    const existing = await mural.listWebhooks();
    const match = existing.find((w) => w.url === webhookUrl);
    if (match) {
      await upsertConfig('webhook_id', match.id);
      // Make sure it's active
      if (match.status !== 'ACTIVE') {
        await mural.updateWebhookStatus(match.id, 'ACTIVE');
      }
      console.log(`[Bootstrap] Found existing webhook: ${match.id}`);
      return;
    }
  } catch (err) {
    console.error('[Bootstrap] Failed to list webhooks:', err);
  }

  try {
    const webhook = await mural.createWebhook(webhookUrl, ['MURAL_ACCOUNT_BALANCE_ACTIVITY', 'PAYOUT_REQUEST']);
    await upsertConfig('webhook_id', webhook.id);
    // Activate it (created as DISABLED)
    await mural.updateWebhookStatus(webhook.id, 'ACTIVE');
    console.log(`[Bootstrap] Created and activated webhook: ${webhook.id} → ${webhookUrl}`);
  } catch (err) {
    console.error('[Bootstrap] Failed to create webhook:', err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert or update a key-value pair in the merchant_config table. */
async function upsertConfig(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO merchant_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

/** Pause execution for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
