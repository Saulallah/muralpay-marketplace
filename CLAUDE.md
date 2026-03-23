# muralpay-marketplace — Claude Context

## What this is
TypeScript/Express backend for the Mural Pay coding challenge. Customers browse products, create orders, and pay in USDC on Polygon. The app detects the deposit, then auto-converts USDC → COP and wires to a Colombian bank via Mural Pay's payout API.

## Stack
- **Runtime**: Node.js 20, TypeScript 5
- **HTTP**: Express 4
- **DB**: PostgreSQL via `pg` (raw SQL, no ORM) — `src/db/index.ts`
- **External API**: Mural Pay Sandbox (`https://api-staging.muralpay.com`) — `src/services/muralPay.ts`

## Key scripts
```
npm run dev          # ts-node-dev hot reload
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run db:migrate   # creates tables + seeds 5 products (idempotent)
```

## Architecture
```
src/index.ts          startup: DB → bootstrap → polling job → HTTP
src/app.ts            Express wiring
src/config.ts         env var management (required/optional helpers)
src/db/               pg pool + query helpers + migration
src/services/
  muralPay.ts         Mural API client (all HTTP calls live here)
  bootstrap.ts        startup provisioning (account/counterparty/webhook)
  paymentProcessor.ts deposit matching + payout initiation
src/routes/
  products.ts         GET /products
  orders.ts           POST /orders, GET /orders/:id
  merchant.ts         merchant-only endpoints (auth guarded)
  webhooks.ts         POST /webhooks/mural
src/jobs/
  pollTransactions.ts 30s polling fallback for deposit detection
src/middleware/
  auth.ts             Bearer token guard (skipped if API_SECRET unset)
```

## Env vars (see .env)
| Var | Required | Notes |
|-----|----------|-------|
| DATABASE_URL | yes | PostgreSQL connection string |
| MURAL_API_KEY | yes | Bearer token for all Mural calls |
| MURAL_TRANSFER_API_KEY | yes | Used only for payout execution (separate header) |
| MURAL_API_BASE_URL | yes | `https://api-staging.muralpay.com` in sandbox |
| APP_URL | no | e.g. `https://myapp.railway.app` — enables webhook registration |
| API_SECRET | no | If set, all routes require `Authorization: Bearer <secret>` |
| MERCHANT_* | yes | COP bank details for the merchant payout method |

## Payment matching strategy
Each order gets a unique `adjusted_total_usdc = total_usdc + (counter × 0.000001)` where `counter` is 0–99, stored in `merchant_config.order_counter` (atomic increment, wraps at 99). Incoming deposits are matched to pending orders within 0.00001 USDC tolerance, closest match first, then oldest.

## Order lifecycle
`pending` → `paid` → `processing_withdrawal` → `withdrawn`
On failure reverts to `paid` (withdrawal can be retried).

## Deployment
Railway — `railway.json` runs `npm run build && npm run db:migrate && npm start`.
Set env vars in Railway dashboard. `APP_URL` should be the Railway public URL to enable webhook auto-registration.

---

## Critical Mural API gotchas (hard-won — read before touching muralPay.ts)

See `src/services/CLAUDE.md` for the full list.
