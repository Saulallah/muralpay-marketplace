# src/services/ — Mural API Reference & Gotchas

## Sandbox funding & end-to-end test flow

### Step 1 — Fund the sending account
1. Log into **app-staging.muralpay.com**
2. **Move Money → Deposit → Bank Accounts → USD** — select **"Main Account"** (NOT Marketplace Main Account)
3. Fake funds appear in ~1-2 minutes

### Step 2 — Send USDC to the marketplace wallet
4. **Move Money → Pay → +Add Contact**
5. Add wallet address `0x7Fd09B2f615C9c6bB20Ea6F1B553723B73940ea7` (Polygon network)
6. Send **FROM "Main Account"** (not Marketplace Main Account) the **exact adjusted amount** from `payment_instructions.amount_usdc`

> **Critical gotcha — sending direction:** Sending FROM the Marketplace Main Account TO its own wallet is an outgoing `payout` originating from our wallet — it gets filtered as an outgoing withdrawal and ignored. You MUST send FROM a **separate** account (e.g. "Main Account") so the `senderAddress` differs from our wallet.

### Step 3 — Monitor the order
```bash
curl https://muralpay-marketplace-production.up.railway.app/merchant/orders | jq '[.orders[] | {status, customer_name, total_usdc}]'
```
Expected progression: `pending` → `paid` → `processing_withdrawal` → `withdrawn`

## muralPay.ts — function index
| Function | Method | Path |
|----------|--------|------|
| getAccounts() | GET | /api/accounts |
| createAccount(name) | POST | /api/accounts |
| getAccount(id) | GET | /api/accounts/:id |
| createCounterparty(info) | POST | /api/counterparties |
| searchCounterparties(email) | POST | /api/counterparties/search |
| createPayoutMethod(cpId, bankDetails) | POST | /api/counterparties/:id/payout-methods |
| searchPayoutMethods(cpId) | POST | /api/counterparties/:id/payout-methods/search |
| createPayoutRequest(...) | POST | /api/payouts/payout |
| executePayoutRequest(id) | POST | /api/payouts/payout/:id/execute |
| getPayoutRequest(id) | GET | /api/payouts/payout/:id |
| searchPayoutRequests(statuses?) | POST | /api/payouts/search |
| searchTransactions(accountId, limit, nextId?) | POST | /api/transactions/search/account/:id |
| listWebhooks() | GET | /api/webhooks |
| createWebhook(url, categories) | POST | /api/webhooks |
| updateWebhookStatus(id, status) | PATCH | /api/webhooks/:id/status |
| deleteWebhook(id) | DELETE | /api/webhooks/:id |
| getSupportedBanks(type?) | GET | /api/counterparties/payment-methods/supported-banks |

## Auth headers
- All requests: `Authorization: Bearer <MURAL_API_KEY>`
- Payout execution only: additionally `transfer-api-key: <MURAL_TRANSFER_API_KEY>`

## KNOWN API QUIRKS — do not repeat these mistakes

### 1. `alias` is required on payout method creation
`POST /api/counterparties/:id/payout-methods` requires a top-level `alias` field.
Without it the API returns a validation error.
```json
{ "alias": "Merchant COP Bank Account", "payoutMethod": { ... } }
```

### 2. Webhooks are created as DISABLED
`POST /api/webhooks` creates the webhook with `status: "DISABLED"`.
You must immediately call `PATCH /api/webhooks/:id/status` with `{ "status": "ACTIVE" }`.
Bootstrap does this automatically.

### 3. `isApiEnabled` must be true to use an account
Accounts created in the Mural dashboard have `isApiEnabled: false` and cannot be used via API.
Only accounts created via `POST /api/accounts` have `isApiEnabled: true`.
Bootstrap filters for `isApiEnabled: true` accounts.

### 4. `transfer-api-key` is a separate header, not a Bearer token
`POST /api/payouts/payout/:id/execute` requires a `transfer-api-key` header with `MURAL_TRANSFER_API_KEY`.
This is distinct from the `Authorization: Bearer` header. Both must be present.

### 5. Supported banks query param is `payoutMethodTypes`, not `fiatRailCode`
```
GET /api/counterparties/payment-methods/supported-banks?payoutMethodTypes=copDomestic
```
Using `fiatRailCode=cop` returns a validation error listing the correct param name.

### 6. MuralPayoutMethod response shape is nested
```typescript
// CORRECT
interface MuralPayoutMethod {
  id: string;
  payoutMethod: { type: string; details: Record<string, unknown> };
}
// WRONG (flat) — the API does NOT return top-level type/details
```

### 7. Account status starts as INITIALIZING
Newly created accounts have `status: "INITIALIZING"`. The wallet address is only available once status is `"ACTIVE"`. Bootstrap polls every 5s, up to 12 times (60s total).

### 8. Mural classifies ALL crypto wallet transfers as `payout`, not `deposit`
`searchTransactions` returns both bank-to-USDC conversions (`deposit` type) and all crypto wallet transfers (`payout` type — including incoming ones). `paymentProcessor.ts` now accepts both types. Outgoing withdrawals are filtered by checking `senderAddress` against the merchant wallet stored in `merchant_config.wallet_address`.

If you send FROM the Marketplace Main Account TO its own wallet, the transaction appears as a `payout` originating FROM our wallet and is correctly filtered out. Always simulate customer payments by sending FROM a **separate** account INTO the marketplace wallet.

## COP payout method details structure
```typescript
{
  type: 'cop',
  details: {
    type: 'copDomestic',
    symbol: 'COP',
    bankId: 'bank_cop_022',           // Bancolombia in sandbox
    bankAccountNumber: '...',
    accountType: 'CHECKING' | 'SAVINGS',
    documentType: 'NATIONAL_ID',
    documentNumber: '...',
    phoneNumber: '+57...',
  }
}
```

## Payout status mapping (Mural → internal)

Two separate mapping functions exist — one used right after execution, one used by the sync job:

**After `executePayoutRequest()` — `mapPayoutStatus()`:**
| Mural status | Withdrawal status | Order status |
|---|---|---|
| AWAITING_EXECUTION | pending | processing_withdrawal |
| PENDING | processing | processing_withdrawal |
| EXECUTED | processing | withdrawn |
| FAILED / CANCELED | failed | paid (reverted) |

**During `syncWithdrawalStatuses()` — `mapPayoutStatusFinal()`:**
| Mural status | Withdrawal status |
|---|---|
| AWAITING_EXECUTION | pending |
| PENDING | processing |
| EXECUTED | **completed** → also flips order to `withdrawn` |
| FAILED / CANCELED | failed |

> `EXECUTED` is Mural's terminal success state. Right after execution the withdrawal is `processing` (funds in transit). The sync job later confirms it as `completed` once the status is re-fetched as `EXECUTED`.

## bootstrap.ts — what it does
1. Finds or creates Mural account (prefers `isApiEnabled: true` + name "Marketplace Main Account")
2. Waits for account to become ACTIVE, then stores wallet address
3. Finds or creates counterparty (merchant individual, Colombian address)
4. Creates COP payout method (Bancolombia)
5. Registers and activates webhook if `APP_URL` is set

All results persisted in `merchant_config` table. Fully idempotent — safe to re-run.
