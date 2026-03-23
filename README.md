# Mural Pay Marketplace

A TypeScript/Express backend that lets customers pay for products in **USDC on Polygon**, then automatically converts the payment to **Colombian Pesos (COP)** and wires it to a Colombian bank account — all powered by the [Mural Pay API](https://developers.muralpay.com).

**Live demo:** `https://muralpay-marketplace-production.up.railway.app`

---

## How It Works

```
Customer                    This Service                 Mural Pay API
   │                              │                            │
   │  1. POST /orders             │                            │
   ├─────────────────────────────►│  Creates order in DB       │
   │◄─────────────────────────────┤  Returns wallet + amount   │
   │                              │                            │
   │  2. Sends exact USDC amount  │                            │
   │─────────────────────────────────────────────────────────►│
   │                              │                            │
   │                              │◄─── Webhook notification ──┤
   │                              │   (+ 30s polling fallback) │
   │                              │                            │
   │                              │  Matches deposit → order   │
   │                              │  Initiates COP payout ────►│
   │                              │                            │
   │                              │            COP → Bank ─────►
```

**Order lifecycle:** `pending` → `paid` → `processing_withdrawal` → `withdrawn`

---

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL database ([Neon](https://neon.tech) free tier works great)
- Mural Pay sandbox account with API keys

### 1. Clone & Install

```bash
git clone https://github.com/Saulallah/muralpay-marketplace
cd muralpay-marketplace
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```env
# Database
DATABASE_URL=postgresql://user:password@host/dbname

# Mural Pay API (get from app-staging.muralpay.com → Settings → API Keys)
MURAL_API_BASE_URL=https://api-staging.muralpay.com
MURAL_API_KEY=your_api_key_here
MURAL_TRANSFER_API_KEY=your_transfer_api_key_here

# Your public URL — required for Mural webhook registration
APP_URL=https://yourapp.railway.app

# Optional: protect merchant endpoints with a bearer token
API_SECRET=your_secret_here

# Merchant COP bank details (used for creating the payout method)
MERCHANT_FIRST_NAME=Jane
MERCHANT_LAST_NAME=Doe
MERCHANT_EMAIL=merchant@example.com
MERCHANT_ADDRESS=123 Main St
MERCHANT_CITY=Bogota
MERCHANT_STATE=Cundinamarca
MERCHANT_COUNTRY=CO
MERCHANT_ZIP=110111
MERCHANT_BANK_ID=bank_cop_022
MERCHANT_BANK_ACCOUNT_NUMBER=1234567890
MERCHANT_ACCOUNT_TYPE=CHECKING
MERCHANT_DOCUMENT_TYPE=NATIONAL_ID
MERCHANT_DOCUMENT_NUMBER=1234567890
MERCHANT_PHONE_NUMBER=+573001234567
```

> **Getting Mural API Keys:**
> 1. Sign in to [app-staging.muralpay.com](https://app-staging.muralpay.com)
> 2. Go to **Settings → API Keys**
> 3. Generate both an **API Key** and a **Transfer API Key**

> **Getting a valid Colombian bank ID:**
> ```bash
> curl -H "Authorization: Bearer $MURAL_API_KEY" \
>   "https://api-staging.muralpay.com/api/counterparties/payment-methods/supported-banks?payoutMethodTypes=copDomestic"
> ```
> Use one of the returned `bankId` values (e.g. `bank_cop_022` = Bancolombia in sandbox).

### 3. Run the Database Migration

```bash
npm run db:migrate
```

This creates all tables and seeds 5 sample Colombian products. Safe to run multiple times — uses `IF NOT EXISTS` and `ON CONFLICT DO NOTHING` throughout.

### 4. Start the Server

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

### 5. Verify Everything Works

```bash
curl http://localhost:3000/health
# → {"status":"ok"}

curl http://localhost:3000/products
# → list of 5 products
```

On first startup, the server automatically:
- Finds or creates the Mural merchant account
- Finds or creates the COP counterparty and bank payout method
- Registers and activates the Mural webhook

---

## Testing the Full Payment Flow

You can run this against the **live deployment** or your local server. Replace `BASE` with whichever you're using:

```bash
# Live deployment (no setup required)
BASE=https://muralpay-marketplace-production.up.railway.app

# OR local dev server (run `npm run dev` first)
BASE=http://localhost:3000
```

---

### Step 1 — Browse the product catalog

```bash
curl $BASE/products | jq '[.products[] | {id, name, price_usdc}]'
```

You'll see 5 products. Note the `id` of the one you want to order — or use the Artisan Coffee Bag which is always `a1000000-0000-0000-0000-000000000001`.

---

### Step 2 — Create an order

```bash
curl -s -X POST $BASE/orders \
  -H "Content-Type: application/json" \
  -d '{
    "product_id": "a1000000-0000-0000-0000-000000000001",
    "customer_name": "Jane Doe",
    "customer_email": "jane@example.com",
    "quantity": 1
  }' | jq .
```

The response contains everything needed to make the payment:

```json
{
  "order": {
    "id": "8c7f7e87-...",
    "status": "pending",
    "total_usdc": 12
  },
  "payment_instructions": {
    "wallet_address": "0x7Fd09B2f615C9c6bB20Ea6F1B553723B73940ea7",
    "amount_usdc": 12.05,
    "token": "USDC",
    "network": "Polygon (AMOY testnet in sandbox)",
    "warning": "Send the exact amount shown. A different amount may result in a failed or mismatched payment."
  }
}
```

Save the `order.id` and `payment_instructions.amount_usdc` — you'll need both.

---

### Step 3 — Send USDC from the Mural sandbox

> **Critical:** Send FROM a **separate** account, not from the Marketplace Main Account.
> Sending from the Marketplace account to itself is recorded as an outgoing transfer and ignored.

1. Log in to [app-staging.muralpay.com](https://app-staging.muralpay.com)
2. **Fund your sending account:**
   - Move Money → Deposit → Bank Accounts → USD
   - Select **"Main Account"** (not Marketplace Main Account)
   - Enter any amount — fake funds appear in ~1–2 minutes
3. **Send the payment:**
   - Move Money → Pay → +Add Contact
   - Paste the `wallet_address` from Step 2 (Polygon network)
   - Select **"Main Account"** as the source
   - Enter the **exact `amount_usdc`** — e.g. `12.05` — copy it precisely

The exact amount is how the system matches the payment to your order. The small cent-level adjustment (e.g. `12.05` instead of `12.00`) is unique per order.

---

### Step 4 — Watch the order status update

The poller checks for new deposits every 30 seconds. Run this to watch the status change in real time:

```bash
watch -n 5 "curl -s $BASE/orders/<your-order-id> | jq '{status: .order.status, updated_at: .order.updated_at}'"
```

Expected progression (usually within 60 seconds of sending):

```
pending  →  paid  →  processing_withdrawal  →  withdrawn
```

- **`pending`** — order created, waiting for payment
- **`paid`** — deposit detected and matched to this order
- **`processing_withdrawal`** — COP payout has been initiated with Mural
- **`withdrawn`** — payout executed, funds in transit to Colombian bank

---

### Step 5 — Inspect the merchant view

```bash
# See all orders and their statuses
curl $BASE/merchant/orders | jq '[.orders[] | {status, customer_name, total_usdc, payment_amount_usdc}]'

# See all COP withdrawals (fetches live status from Mural)
curl $BASE/merchant/withdrawals | jq '.withdrawals'

# Check account balance
curl $BASE/merchant/account | jq '.account.accountDetails.balances'
```

---

### What a successful end-to-end run looks like

```bash
# 1. Create the order
RESPONSE=$(curl -s -X POST $BASE/orders \
  -H "Content-Type: application/json" \
  -d '{"product_id":"a1000000-0000-0000-0000-000000000001","customer_name":"Test","customer_email":"t@t.com"}')

ORDER_ID=$(echo $RESPONSE | jq -r .order.id)
AMOUNT=$(echo $RESPONSE | jq .payment_instructions.amount_usdc)

echo "Order: $ORDER_ID"
echo "Send exactly $AMOUNT USDC to the wallet"

# 2. After sending payment in Mural dashboard, poll for status
watch -n 5 "curl -s $BASE/orders/$ORDER_ID | jq .order.status"

# 3. Once withdrawn, check the withdrawal record
curl $BASE/merchant/withdrawals | jq '.withdrawals[0]'
```

---

## API Reference

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/health` | | Server health check |
| GET | `/products` | | List all active products |
| GET | `/products/:id` | | Get a single product |
| POST | `/products` | ✓ | Create a new product |
| DELETE | `/products/:id` | ✓ | Deactivate a product |
| POST | `/orders` | | Create order + get payment instructions |
| GET | `/orders/:id` | | Get order status and payment details |
| GET | `/merchant/orders` | ✓ | All orders (merchant view) |
| GET | `/merchant/orders/:id` | ✓ | Single order with withdrawal info |
| GET | `/merchant/withdrawals` | ✓ | All COP withdrawals (syncs live status) |
| GET | `/merchant/withdrawals/:id` | ✓ | Single withdrawal with live Mural status |
| GET | `/merchant/account` | ✓ | Mural account balance and wallet |
| GET | `/merchant/config` | ✓ | Stored configuration (IDs, wallet address) |
| POST | `/webhooks/mural` | | Mural Pay webhook receiver |

**Auth:** If `API_SECRET` is set, protected endpoints require `Authorization: Bearer <secret>`.

Full OpenAPI spec: [`openapi.json`](./openapi.json)

---

## Running Tests

The test suite has two layers: **unit tests** (pure logic, no network) and **integration tests** (live HTTP calls against the deployed API).

### Unit Tests

No setup needed — these mock the database and Mural API entirely.

```bash
npm run test:unit
```

What they cover:
- Deposit matching: dedup check, amount tolerance, race condition guard
- Outgoing payout filter (skips transactions sent from our own wallet)
- Withdrawal revert when payout creation fails
- Payout status mapping (`EXECUTED` → `completed`, `FAILED` → `failed`, etc.)
- Amount adjustment math and uniqueness across all 99 counter values
- Tolerance boundary: adjacent 1-cent steps never cross-match

### Integration Tests

These run against the **live Railway deployment** by default. Make sure the server is up before running.

```bash
npm run test:integration
```

To test against a **local dev server** instead:

```bash
# Terminal 1 — start the server
npm run dev

# Terminal 2 — run tests against it
BASE_URL=http://localhost:3000 npm run test:integration
```

What they cover:
- `GET /products` — returns exactly 5 products, all fields are correct types
- `POST /orders` — creates order, returns payment instructions with a valid adjusted amount
- `POST /orders` validation — rejects missing fields, zero/negative/fractional quantity, unknown product
- `GET /orders/:id` — returns full order details including deposit wallet address
- `GET /merchant/orders` and `/merchant/withdrawals` — accessible and return arrays
- `GET /merchant/account` — account is `ACTIVE`, has balance and a valid wallet address
- `GET /health` — returns `ok`
- Unknown routes return 404

### Run Everything

```bash
npm test
```

Expected output:

```
Test Suites: 3 passed, 3 total
Tests:       42 passed, 42 total
```

---

## Deployment (Railway)

The live deployment uses Railway + Neon PostgreSQL. To deploy your own:

1. Push code to GitHub
2. Create a [Railway](https://railway.app) project → **Deploy from GitHub repo**
3. Add all environment variables in the Railway dashboard
4. Set `APP_URL` to your Railway-generated domain
5. The build command (`npm run build && npm run db:migrate && npm start`) runs automatically on each deploy

**To redeploy manually** (if Railway doesn't auto-deploy):
```bash
RAILWAY_TOKEN=<your-project-token> railway up --service <service-name>
```

> Note: Railway's `serviceInstanceDeploy` GraphQL mutation redeploys the last uploaded snapshot, not the latest git commit. Use `railway up` to upload and deploy in one step.

---

## How Deposit Matching Works

Since all customers send USDC to the **same wallet address**, the system needs a way to tell which payment belongs to which order.

**The solution:** Each order gets a slightly adjusted amount. The base price gets a 1-cent increment — `price + (counter × $0.01)` — where the counter runs 1–99 and wraps. So a $12 coffee becomes $12.01, $12.02, etc. The customer sends this exact amount, and the system matches it to the corresponding order within a ±$0.005 tolerance.

**Why 2 decimal places?** Mural's UI only accepts amounts to 2 decimal places. An earlier approach used 6-decimal adjustments (e.g. `12.000004`) which couldn't be entered in Mural's send interface.

**Known limitations:**
- If 99+ orders for the same product are pending at once, counter values repeat and matching becomes ambiguous
- A customer sending the wrong amount leaves their order stuck in `pending` — there's no automatic refund
- Very old pending orders could match a new unrelated deposit (no order expiry is implemented)

**Production alternatives:**
- Create a separate Mural account per order (unique wallet address per order — most reliable)
- Use on-chain memos/reference fields if Mural adds support for that

---

## How the Mural Webhook Works

The service subscribes to `MURAL_ACCOUNT_BALANCE_ACTIVITY` events. When Mural detects a deposit or wallet transfer:

1. Mural POSTs to `/webhooks/mural`
2. The handler reads `eventCategory` and `payload` from the body
3. If it's a balance activity event, the transaction is passed to `matchAndProcessDeposit()`
4. The poller (every 30s) serves as a fallback in case webhook delivery fails

**Important:** Mural classifies all crypto wallet transfers as type `payout`, not `deposit`. The service handles both types. Outgoing withdrawal transactions are filtered out by checking if the sender address matches the merchant wallet.

> Webhook signature verification (ECDSA via the `X-Mural-Signature` header) is not implemented. In production, verify the signature using the webhook's `publicKey` to prevent spoofed events.

---

## Project Structure

```
src/
├── index.ts                  # Startup: DB → bootstrap → polling → HTTP
├── app.ts                    # Express app and route mounting
├── config.ts                 # All env vars in one place
├── db/
│   ├── index.ts              # pg pool + query/queryOne helpers
│   └── migrate.ts            # Idempotent DDL + product seed
├── services/
│   ├── muralPay.ts           # Mural API client (all HTTP calls)
│   ├── bootstrap.ts          # Startup provisioning (account/counterparty/webhook)
│   └── paymentProcessor.ts   # Deposit matching + payout initiation + status sync
├── routes/
│   ├── products.ts           # GET/POST/DELETE /products
│   ├── orders.ts             # POST/GET /orders
│   ├── merchant.ts           # /merchant/* (auth-protected)
│   └── webhooks.ts           # POST /webhooks/mural
├── jobs/
│   └── pollTransactions.ts   # 30s polling fallback
└── middleware/
    └── auth.ts               # Bearer token guard

tests/
├── unit/
│   ├── paymentProcessor.test.ts
│   └── orderAmount.test.ts
└── integration/
    └── api.test.ts
```

---

## Future Improvements

1. **Webhook signature verification** — Verify ECDSA signatures from Mural to prevent spoofed events
2. **Idempotency keys** — Use Mural's `idempotency-key` header on payout creation to prevent double-payouts on retries
3. **Order expiration** — Auto-expire `pending` orders after N hours to avoid stale matches
4. **Retry with backoff** — Exponential backoff on transient Mural API failures
5. **Refund flow** — Return USDC to sender if payout fails after payment is received
6. **Partial payment handling** — Detect and flag underpayments gracefully
7. **Rate limiting** — Protect public endpoints from abuse
8. **Shopping cart** — Support multiple products per order
9. **Versioned migrations** — Replace the single migration script with a proper tool (e.g. `node-pg-migrate`)
10. **Error monitoring** — Integrate Sentry or similar for production observability
