# src/db/ — Database Layer

## Connection
`pg.Pool` — SSL enabled unless `DATABASE_URL` host is localhost/127.0.0.1.
Exported helpers:
- `query<T>(sql, params?)` → `T[]`
- `queryOne<T>(sql, params?)` → `T | null`

## Migration
`migrate.ts` is a standalone script — run via `npm run db:migrate` (`ts-node src/db/migrate.ts`).
Uses `IF NOT EXISTS` everywhere — fully idempotent, safe to re-run.
Seeds 5 Colombian marketplace products with `ON CONFLICT (id) DO NOTHING`.

Requires `pgcrypto` extension (for `gen_random_uuid()`). The migration creates it automatically.

### Seed idempotency — important
The seed uses **fixed UUIDs** (`a1000000-0000-0000-0000-00000000000{1-5}`) so `ON CONFLICT (id) DO NOTHING`
reliably prevents duplicates on every re-run. Do NOT change the seed to use `gen_random_uuid()` —
that was the original bug that caused 5 duplicate products to appear after each deploy.

## Schema notes

### orders.adjusted_total_usdc
Stored as `DECIMAL(18,6)`. The per-order unique amount is `total_usdc + (counter × 0.01)` (1-cent steps).
The counter comes from `merchant_config.order_counter` (1–99, incremented atomically, wraps at 99):
```sql
INSERT INTO merchant_config (key, value, updated_at)
VALUES ('order_counter', '1', NOW())
ON CONFLICT (key) DO UPDATE
  SET value = (CAST(merchant_config.value AS INT) % 99 + 1)::TEXT,
      updated_at = NOW()
```
The result is always 2 decimal places (e.g. `12.01`, `12.02`…`12.99`) — required because Mural's UI
only accepts amounts to 2 decimal places. The matching tolerance in `paymentProcessor.ts` is **0.005 USDC**.

### Key indexes
- `idx_orders_status` on `orders(status)` — for polling pending orders
- `idx_orders_adjusted_total` on `orders(adjusted_total_usdc)` — for deposit matching
- `idx_orders_transaction_id` on `orders(transaction_id)` — dedup check

### merchant_config
Key-value store for runtime configuration. All values are TEXT.
Write via `upsertConfig(key, value)` in `bootstrap.ts`.
Do not hard-code these values anywhere — always read from DB at runtime.
