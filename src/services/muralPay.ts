import fetch from 'node-fetch';
import { config } from '../config';

const BASE = config.mural.baseUrl;

/** Builds the standard headers for a Mural API request, optionally merging extra headers (e.g. transfer-api-key). */
function authHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.mural.apiKey}`,
    ...extraHeaders,
  };
}

/**
 * Generic HTTP helper for all Mural API calls. Sends the request, reads the
 * response body as text, and throws a descriptive error if the status is not 2xx.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(extraHeaders),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Mural API error ${res.status} ${method} ${path}: ${text}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MuralAccount {
  id: string;
  name: string;
  status: 'INITIALIZING' | 'ACTIVE';
  isApiEnabled: boolean;
  destinationToken: { symbol: string; blockchain: string };
  accountDetails?: {
    balances: Array<{ tokenAmount: number; tokenSymbol: string }>;
    walletDetails: { blockchain: string; walletAddress: string };
    payinMethods: Array<{
      status: string;
      payinRailDetails: {
        type: string;
        destinationAddress?: string;
        depositToken?: unknown;
      };
      supportedDestinationTokens: unknown[];
    }>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MuralCounterparty {
  id: string;
  name: string;
  type: 'counterparty';
}

export interface MuralPayoutMethod {
  id: string;
  counterpartyId: string;
  alias: string;
  payoutMethod: {
    type: string;
    details: Record<string, unknown>;
  };
  createdAt: string;
}

export interface MuralPayoutRequest {
  id: string;
  sourceAccountId: string;
  status: 'AWAITING_EXECUTION' | 'CANCELED' | 'PENDING' | 'EXECUTED' | 'FAILED';
  payouts: Array<{
    id: string;
    amount: { tokenAmount: number; tokenSymbol: string };
    details: unknown;
    recipientInfo: unknown;
    createdAt: string;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface MuralTransaction {
  id: string;
  hash: string;
  transactionExecutionDate: string;
  blockchain: string;
  amount: { tokenAmount: number; tokenSymbol: string };
  accountId: string;
  counterpartyInfo: unknown;
  transactionDetails: {
    type: string;
    details?: {
      type: string;
      senderAddress?: string;
      blockchain?: string;
    };
  };
  memo?: string;
}

export interface MuralWebhook {
  id: string;
  url: string;
  categories: string[];
  status: 'ACTIVE' | 'DISABLED';
  publicKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

/** Fetch all Mural accounts belonging to this organization. */
export async function getAccounts(): Promise<MuralAccount[]> {
  return request<MuralAccount[]>('GET', '/api/accounts');
}

/** Create a new Mural account that receives USDC on Polygon. */
export async function createAccount(name: string): Promise<MuralAccount> {
  return request<MuralAccount>('POST', '/api/accounts', {
    name,
    destinationToken: { symbol: 'USDC', blockchain: 'POLYGON' },
  });
}

/** Fetch a single Mural account by ID, including balances and wallet details. */
export async function getAccount(id: string): Promise<MuralAccount> {
  return request<MuralAccount>('GET', `/api/accounts/${id}`);
}

// ─── Counterparties ───────────────────────────────────────────────────────────

/**
 * Create a new individual counterparty (the person or business that will receive payouts).
 * Used during bootstrap to register the merchant as a COP payout recipient.
 */
export async function createCounterparty(info: {
  firstName: string;
  lastName: string;
  email: string;
  address: string;
  city: string;
  state: string;
  country: string;
  zip: string;
}): Promise<MuralCounterparty & { id: string }> {
  return request<MuralCounterparty & { id: string }>('POST', '/api/counterparties', {
    counterparty: {
      type: 'individual',
      firstName: info.firstName,
      lastName: info.lastName,
      email: info.email,
      physicalAddress: {
        address1: info.address,
        country: info.country,
        subDivision: info.state,
        city: info.city,
        postalCode: info.zip,
      },
    },
  });
}

/** Search for existing counterparties by email address. */
export async function searchCounterparties(email: string): Promise<Array<{ id: string; name: string }>> {
  const res = await request<{ results: Array<{ id: string; name: string }> }>('POST', '/api/counterparties/search', {
    filter: { type: 'email', email },
  });
  return res.results ?? [];
}

// ─── Payout Methods ───────────────────────────────────────────────────────────

/**
 * Register a Colombian bank account (COP) as a payout method for a counterparty.
 * NOTE: the top-level `alias` field is required by the Mural API — omitting it causes a validation error.
 */
export async function createPayoutMethod(
  counterpartyId: string,
  bankDetails: {
    bankId: string;
    bankAccountNumber: string;
    accountType: 'CHECKING' | 'SAVINGS';
    documentType: string;
    documentNumber: string;
    phoneNumber: string;
  }
): Promise<MuralPayoutMethod> {
  return request<MuralPayoutMethod>('POST', `/api/counterparties/${counterpartyId}/payout-methods`, {
    alias: 'Merchant COP Bank Account',
    payoutMethod: {
      type: 'cop',
      details: {
        type: 'copDomestic',
        symbol: 'COP',
        bankId: bankDetails.bankId,
        bankAccountNumber: bankDetails.bankAccountNumber,
        accountType: bankDetails.accountType,
        documentType: bankDetails.documentType,
        documentNumber: bankDetails.documentNumber,
        phoneNumber: bankDetails.phoneNumber,
      },
    },
  });
}

/** Fetch all payout methods registered for a counterparty. */
export async function searchPayoutMethods(counterpartyId: string): Promise<MuralPayoutMethod[]> {
  const res = await request<{ results: MuralPayoutMethod[] }>(
    'POST',
    `/api/counterparties/${counterpartyId}/payout-methods/search`,
    { filter: {} }
  );
  return res.results ?? [];
}

// ─── Payouts ──────────────────────────────────────────────────────────────────

/**
 * Create a payout request to send USDC from a Mural account to a counterparty's bank.
 * This only *creates* the request — you must call executePayoutRequest() to actually send the funds.
 */
export async function createPayoutRequest(
  sourceAccountId: string,
  counterpartyId: string,
  payoutMethodId: string,
  amountUsdc: number,
  memo: string
): Promise<MuralPayoutRequest> {
  return request<MuralPayoutRequest>('POST', '/api/payouts/payout', {
    sourceAccountId,
    memo,
    payouts: [
      {
        amount: { tokenAmount: amountUsdc, tokenSymbol: 'USDC' },
        payoutDetails: {
          type: 'counterpartyPayoutMethod',
          payoutMethodId,
        },
        recipientInfo: {
          type: 'counterpartyInfo',
          counterpartyId,
        },
      },
    ],
  });
}

/**
 * Execute a previously created payout request, triggering the actual fund transfer.
 * Requires the separate MURAL_TRANSFER_API_KEY passed as a `transfer-api-key` header
 * (different from the normal Bearer token).
 */
export async function executePayoutRequest(payoutRequestId: string): Promise<MuralPayoutRequest> {
  return request<MuralPayoutRequest>(
    'POST',
    `/api/payouts/payout/${payoutRequestId}/execute`,
    { exchangeRateToleranceMode: 'FLEXIBLE' },
    { 'transfer-api-key': config.mural.transferApiKey }
  );
}

/** Fetch the current status of a payout request by its ID. */
export async function getPayoutRequest(id: string): Promise<MuralPayoutRequest> {
  return request<MuralPayoutRequest>('GET', `/api/payouts/payout/${id}`);
}

/** Search payout requests, optionally filtered by one or more status values (e.g. ['PENDING', 'EXECUTED']). */
export async function searchPayoutRequests(statuses?: string[]): Promise<{ results: MuralPayoutRequest[] }> {
  return request<{ results: MuralPayoutRequest[] }>('POST', '/api/payouts/search', {
    filter: statuses
      ? { type: 'payoutStatus', statuses }
      : {},
  });
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * Fetch recent transactions for a Mural account, newest first.
 * Supports pagination via nextId. Used by the polling job to detect incoming deposits.
 */
export async function searchTransactions(
  accountId: string,
  limit = 50,
  nextId?: string
): Promise<{ results: MuralTransaction[]; nextId?: string }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (nextId) params.set('nextId', nextId);

  return request<{ results: MuralTransaction[]; nextId?: string }>(
    'POST',
    `/api/transactions/search/account/${accountId}?${params}`,
    {}
  );
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/** List all registered webhooks for this organization. */
export async function listWebhooks(): Promise<MuralWebhook[]> {
  return request<MuralWebhook[]>('GET', '/api/webhooks');
}

/**
 * Register a new webhook URL for the given event categories.
 * NOTE: webhooks are created with status DISABLED — call updateWebhookStatus() to activate.
 */
export async function createWebhook(url: string, categories: string[]): Promise<MuralWebhook> {
  return request<MuralWebhook>('POST', '/api/webhooks', { url, categories });
}

/** Activate or deactivate a webhook by changing its status to ACTIVE or DISABLED. */
export async function updateWebhookStatus(webhookId: string, status: 'ACTIVE' | 'DISABLED'): Promise<MuralWebhook> {
  return request<MuralWebhook>('PATCH', `/api/webhooks/${webhookId}/status`, { status });
}

/** Permanently delete a webhook registration. */
export async function deleteWebhook(webhookId: string): Promise<void> {
  await request<void>('DELETE', `/api/webhooks/${webhookId}`);
}

// ─── Supported Banks ──────────────────────────────────────────────────────────

/**
 * Fetch the list of supported banks for a given payout method type.
 * Default is 'copDomestic' (Colombian domestic bank transfers).
 * NOTE: the query param is `payoutMethodTypes`, not `fiatRailCode`.
 */
export async function getSupportedBanks(payoutMethodType = 'copDomestic'): Promise<unknown> {
  return request<unknown>('GET', `/api/counterparties/payment-methods/supported-banks?payoutMethodTypes=${payoutMethodType}`);
}
