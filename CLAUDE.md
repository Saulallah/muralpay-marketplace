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
npm run dev              # ts-node-dev hot reload
npm run build            # tsc → dist/
npm start                # node dist/index.js
npm run db:migrate       # creates tables + seeds 5 products (idempotent)
npm test                 # all tests (unit + integration)
npm run test:unit        # unit tests only — no network, fast
npm run test:integration # integration tests against live Railway URL
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
  paymentProcessor.ts deposit matching + payout initiation + status sync
src/routes/
  products.ts         GET/POST/DELETE /products (price_usdc returned as float)
  orders.ts           POST /orders, GET /orders/:id
  merchant.ts         merchant-only endpoints (auth guarded)
  webhooks.ts         POST /webhooks/mural
src/jobs/
  pollTransactions.ts 30s polling fallback for deposit detection
src/middleware/
  auth.ts             Bearer token guard (skipped if API_SECRET unset)
tests/
  unit/               pure logic tests — no DB/network (Jest + ts-jest)
  integration/        live HTTP tests against Railway endpoint
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
Each order gets a unique `adjusted_total_usdc = total_usdc + (counter × 0.01)` where `counter` is 1–99, stored in `merchant_config.order_counter` (atomic increment, wraps at 99). This keeps amounts to 2 decimal places (e.g. `12.05`) so customers can enter the exact amount in any wallet UI. Incoming deposits are matched to pending orders within **0.005 USDC** tolerance (half a cent), closest match first, then oldest.

> **Why 2 decimal places?** Mural's UI only accepts amounts to 2 decimal places. The original 6-decimal approach (e.g. `12.000004`) couldn't be entered by the customer.

## Order lifecycle
`pending` → `paid` → `processing_withdrawal` → `withdrawn`
On failure reverts to `paid` (withdrawal can be retried).

## Live deployment
- **Railway URL**: `https://muralpay-marketplace-production.up.railway.app`
- **GitHub**: `https://github.com/Saulallah/muralpay-marketplace`
- **Database**: Neon PostgreSQL (project `small-night-18277679`)
- Railway runs `npm run build && npm run db:migrate && npm start` on every deploy (`railway.json`)
- Redeploy via Railway GraphQL API: `mutation { serviceInstanceDeploy(serviceId: "909d9aa1-0897-45ef-b9ca-df5f3f192e2c", environmentId: "b127b53a-41ba-4d56-8fa4-f3c3bb5e8135") }`
- **`serviceInstanceDeploy` redeploys the last snapshot, NOT the latest commit.** To deploy new code, use `railway up` with the project token instead:
  ```
  RAILWAY_TOKEN=56cd03dc-10c0-4290-9d8d-af5ccc26da03 railway up --service muralpay-marketplace
  ```

## Provisioned sandbox resources
| Resource | ID |
|---|---|
| Mural account | `2e67d3a5-0b7e-41f8-b36b-e555e55a96f8` |
| Polygon wallet | `0x7Fd09B2f615C9c6bB20Ea6F1B553723B73940ea7` |
| Counterparty | `44a8b102-87f3-4c86-ba04-b011186b2f7a` |
| Payout method | `e6b4b096-ba04-4dc3-bdfb-7ce5ddce390f` |
| Webhook | `9edf0ee5-50c5-4995-bc0e-80af78acd7b5` |

---

## Critical Mural API gotchas (hard-won — read before touching muralPay.ts)

See `src/services/CLAUDE.md` for the full list.
