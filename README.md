# Mural Pay Marketplace Backend

A backend service powering a marketplace that accepts USDC payments on Polygon and automatically converts them to Colombian Pesos (COP) via the [Mural Pay API](https://developers.muralpay.com).

## Architecture Overview

```
Customer                    Backend                      Mural Pay API
   │                           │                               │
   │  POST /orders             │                               │
   ├──────────────────────────►│  (creates order in DB)        │
   │                           │  GET wallet address from DB   │
   │◄──────────────────────────┤                               │
   │  { wallet_address,        │                               │
   │    amount_usdc }          │                               │
   │                           │                               │
   │  [Sends USDC on Polygon]  │                               │
   │─────────────────────────────────────────────────────────►│
   │                           │                               │
   │                           │◄──────────── Webhook ─────────┤
   │                           │  MURAL_ACCOUNT_BALANCE_ACTIVITY
   │                           │  (+ polling fallback every 30s)
   │                           │                               │
   │                           │  Match deposit → order         │
   │                           │  POST /api/payouts/payout      │
   │                           ├──────────────────────────────►│
   │                           │  POST /api/payouts/{id}/execute│
   │                           ├──────────────────────────────►│
   │                           │                               │
   │                           │         [COP → Merchant Bank] │
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | - | Health check |
| GET | `/products` | - | List active products |
| GET | `/products/:id` | - | Get single product |
| POST | `/products` | ✓ | Create product |
| DELETE | `/products/:id` | ✓ | Deactivate product |
| POST | `/orders` | - | Create order + get payment instructions |
| GET | `/orders/:id` | - | Get order status |
| GET | `/merchant/orders` | ✓ | All orders (merchant view) |
| GET | `/merchant/orders/:id` | ✓ | Single order + withdrawal |
| GET | `/merchant/withdrawals` | ✓ | All COP withdrawals |
| GET | `/merchant/withdrawals/:id` | ✓ | Single withdrawal (live status) |
| GET | `/merchant/account` | ✓ | Mural account info + balance |
| GET | `/merchant/config` | ✓ | Stored config (IDs, wallet) |
| POST | `/webhooks/mural` | - | Mural Pay webhook receiver |

Full OpenAPI spec: [`openapi.json`](./openapi.json)

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL database (e.g. [Neon](https://neon.tech), Railway, or local)
- Mural Pay sandbox account with API keys

### 1. Clone & Install

```bash
git clone <repo-url>
cd muralpay-marketplace
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✓ | PostgreSQL connection string |
| `MURAL_API_KEY` | ✓ | Mural Pay API key (from dashboard) |
| `MURAL_TRANSFER_API_KEY` | ✓ | Mural Pay Transfer API key |
| `APP_URL` | Recommended | Your public URL (e.g. `https://yourapp.railway.app`) — used for webhook registration |
| `API_SECRET` | Optional | Bearer token for merchant endpoints |
| `PORT` | Optional | HTTP port (default: 3000) |
| `MERCHANT_*` | Optional | Colombian bank details (defaults are fake sandbox values) |

**Getting Mural API Keys:**
1. Log in to [Mural Pay Sandbox](https://app-staging.muralpay.com)
2. Create a Business Organization
3. Go to Settings → API Keys → Generate API Key + Transfer API Key

**Getting a valid Colombian bank ID:**
```bash
curl -H "Authorization: Bearer $MURAL_API_KEY" \
  https://api-staging.muralpay.com/api/counterparties/payment-methods/supported-banks?fiatRailCode=cop
```
Use one of the returned `bankId` values for `MERCHANT_BANK_ID`.

### 3. Run Database Migration

```bash
npm run db:migrate
```

This creates the tables and seeds 5 sample products.

### 4. Start the Server

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build && npm start
```

### 5. Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/products
```

## Testing the Full Flow

### Step 1: Browse Products
```bash
curl http://localhost:3000/products
```

### Step 2: Create an Order
```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "product_id": "<product-uuid>",
    "customer_name": "Jane Doe",
    "customer_email": "jane@example.com",
    "quantity": 1
  }'
```

Response includes:
```json
{
  "payment_instructions": {
    "wallet_address": "0xYourMuralWalletAddress",
    "amount_usdc": 12.000001,
    "network": "Polygon (AMOY testnet in sandbox)"
  }
}
```

### Step 3: Send USDC (Sandbox)
In the Mural sandbox dashboard:
- Move Money → Pay → Add Contact → Add Wallet Address (use your personal test wallet)
- Send the exact USDC amount shown in payment_instructions to trigger a deposit to your merchant account

Or fund with testnet USDC from Circle's faucet, then send from your wallet to the merchant wallet address.

### Step 4: Check Order Status
```bash
curl http://localhost:3000/orders/<order-id>
```

The status will progress: `pending` → `paid` → `processing_withdrawal` → `withdrawn`

### Step 5: Check Merchant View
```bash
# With auth (if API_SECRET is set)
curl -H "Authorization: Bearer your_secret" http://localhost:3000/merchant/orders
curl -H "Authorization: Bearer your_secret" http://localhost:3000/merchant/withdrawals
```

## Deployment (Railway)

1. Push code to GitHub
2. Create a new Railway project → Deploy from GitHub
3. Add a PostgreSQL service
4. Set all environment variables in Railway dashboard
5. Run migration: `npm run db:migrate`
6. Set `APP_URL` to your Railway domain

The app auto-registers the Mural webhook on startup.

## Current Status

**Working:**
- ✅ Product catalog (list, get, create, deactivate)
- ✅ Order creation with USDC payment instructions
- ✅ Order status tracking
- ✅ Mural Pay account auto-provisioning on startup
- ✅ Counterparty (COP bank) auto-provisioning on startup
- ✅ Webhook registration and handling (MURAL_ACCOUNT_BALANCE_ACTIVITY)
- ✅ Background polling fallback (every 30s)
- ✅ Deposit → order matching logic
- ✅ Automatic COP payout trigger on payment detection
- ✅ Payout status sync
- ✅ Merchant dashboard endpoints (orders, withdrawals, account, config)
- ✅ OpenAPI spec

**Not fully tested / caveats:**
- Webhook signature verification (ECDSA) is not implemented — see production notes below
- The Colombian bank ID in the default config may need to be updated from the `/supported-banks` endpoint

## Pitfalls of the Payment Matching System

This is the trickiest part of the challenge. Since customers send USDC to a **shared wallet address**, we cannot use a unique deposit address per order (Mural provides one wallet per account).

**Our approach:** Each order gets a slightly adjusted USDC amount (e.g., `12.000001` instead of `12.000000`). The increment is a counter (1–99) × 0.000001 USDC, making each pending order's expected amount unique. We match incoming deposits by finding the pending order with the closest matching amount within a 0.00001 USDC tolerance.

**Known pitfalls:**
1. **Counter wraps at 99** — If 100+ orders for the same product amount are pending simultaneously, two orders will have identical adjusted amounts, causing a mis-match.
2. **Wrong amount sent** — If a customer sends a different amount, the order stays `pending` forever. No refund mechanism exists.
3. **Timing ambiguity** — If a deposit arrives before the order is created (very unlikely but possible), it won't be matched.
4. **Multiple deposits** — If a customer sends USDC twice (e.g., correcting a mistake), the second deposit may match a different order.
5. **Rounding** — USDC has 6 decimal places; extremely small adjustments may not survive wallet UI rounding.

**Better production alternatives:**
- Use a separate Mural account per order (one wallet address = one order) — most reliable but requires dynamic account creation
- Use the memo/reference field on-chain (not currently supported by Mural's deposit detection)
- Require customers to use a specific sender wallet address tied to their order

## Future Work

To make this production-ready, I would add:

1. **Webhook signature verification** — Verify the ECDSA signature from Mural using the webhook's `publicKey` to prevent spoofed events.
2. **Idempotent payout execution** — Use Mural's `idempotency-key` header when creating/executing payouts to prevent double-payouts on retries.
3. **Order expiration** — Expire `pending` orders after N hours; prevent matching with stale orders.
4. **Retry logic with exponential backoff** — For Mural API calls that fail transiently.
5. **Proper error tracking** — Integrate Sentry or similar for production error monitoring.
6. **Admin UI** — Simple dashboard to view orders, withdrawals, and trigger manual actions.
7. **Rate limiting** — Protect endpoints from abuse.
8. **Database migrations versioning** — Use a proper migration tool (e.g., `node-pg-migrate` or `Flyway`).
9. **Multiple products per order** — Shopping cart support (currently one product per order).
10. **Refund flow** — Handle cases where payment is received but payout fails; refund USDC to sender.
11. **Partial payment handling** — Detect and handle underpayments gracefully.
12. **KYC/compliance checks** — Ensure counterparty KYC is complete before payouts.
13. **Audit log** — Immutable log of all state transitions for compliance.
14. **Multi-merchant support** — Support multiple merchant organizations.
