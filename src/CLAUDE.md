# src/ — Module Map

## Entry & wiring
- `index.ts` — startup sequence: connect pool → bootstrapMerchant() → startPollingJob() → app.listen()
- `app.ts` — Express app; mounts routes, 404 handler
- `config.ts` — all env vars in one place; `required()` throws at startup if missing

## db/
- `index.ts` — exports `query<T>(sql, params)` and `queryOne<T>(sql, params)`. SSL enabled unless host is localhost.
- `migrate.ts` — idempotent DDL + seed (5 Colombian products using fixed UUIDs). Run standalone via `ts-node`. See `db/CLAUDE.md` for seed idempotency details.

### Schema summary
```sql
products          id, name, description, price_usdc, image_url, active
orders            id, product_id, customer_name, customer_email, quantity,
                  unit_price_usdc, total_usdc, adjusted_total_usdc,
                  deposit_wallet_address, mural_account_id,
                  status, transaction_hash, transaction_id
withdrawals       id, order_id, mural_payout_request_id, status,
                  amount_usdc, counterparty_id, payout_method_id
merchant_config   key TEXT PK, value TEXT
```

### merchant_config keys
| key | value |
|-----|-------|
| mural_account_id | Mural account UUID |
| wallet_address | Polygon wallet for deposits |
| wallet_blockchain | e.g. POLYGON |
| counterparty_id | Merchant's Mural counterparty UUID |
| payout_method_id | COP payout method UUID |
| webhook_id | Registered webhook UUID |
| order_counter | 1–99 integer (wraps at 99), for unique deposit amounts |

## services/
- `muralPay.ts` — pure HTTP client; no business logic; all Mural API calls
- `bootstrap.ts` — idempotent startup provisioner; stores results in merchant_config
- `paymentProcessor.ts` — `matchAndProcessDeposit(tx)` + `initiateWithdrawal()` + `syncWithdrawalStatuses()`

### paymentProcessor.ts — key logic notes
- Accepts both `deposit` and `payout` transaction types (Mural classifies incoming crypto transfers as `payout`)
- Skips `payout` transactions where `senderAddress` == our wallet (those are our own outgoing withdrawals)
- Uses `UPDATE ... WHERE status = 'pending' RETURNING id` to guard against concurrent double-processing
- `syncWithdrawalStatuses()` maps Mural `EXECUTED` → internal `completed`, then flips order to `withdrawn`

## routes/
- `products.ts` — `GET /products`, `GET /products/:id` (public); `POST`, `DELETE /products/:id` (auth). Returns `price_usdc` as a float (not raw DB string)
- `orders.ts` — `POST /orders`, `GET /orders/:id` (public)
- `merchant.ts` — `GET /merchant/orders`, `/merchant/orders/:id`, `/merchant/withdrawals`, `/merchant/withdrawals/:id`, `/merchant/account`, `/merchant/config` — all require auth
- `webhooks.ts` — `POST /webhooks/mural` — reads `eventCategory` + `payload` fields (NOT `category`/`data`); responds 200 immediately, processes async

## jobs/
- `pollTransactions.ts` — polls Mural every 30s for last 20 transactions; calls `matchAndProcessDeposit` on each; syncs withdrawal statuses every 4th cycle

## middleware/
- `auth.ts` — if `API_SECRET` set, validates `Authorization: Bearer` header; otherwise no-op

## tests/
- `tests/unit/paymentProcessor.test.ts` — mocks DB + Mural API; tests matching, dedup, race condition, outgoing filter, withdrawal revert
- `tests/unit/orderAmount.test.ts` — pure math: amount adjustment, total calculation, tolerance matching
- `tests/integration/api.test.ts` — live HTTP tests against Railway; covers all endpoints, validation, and data shapes
- Run: `npm test` | `npm run test:unit` | `npm run test:integration`
- Override endpoint: `BASE_URL=http://localhost:3000 npm run test:integration`
