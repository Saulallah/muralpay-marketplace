# src/db/ — Database Layer

## Connection
`pg.Pool` — SSL enabled unless `DATABASE_URL` host is localhost/127.0.0.1.
Exported helpers:
- `query<T>(sql, params?)` → `T[]`
- `queryOne<T>(sql, params?)` → `T | null`

## Migration
`migrate.ts` is a standalone script — run via `npm run db:migrate` (`ts-node src/db/migrate.ts`).
Uses `IF NOT EXISTS` everywhere — fully idempotent, safe to re-run.
Seeds 5 Colombian marketplace products with `ON CONFLICT DO NOTHING`.

Requires `pgcrypto` extension (for `gen_random_uuid()`). The migration creates it automatically.

## Schema notes

### orders.adjusted_total_usdc
Stored as `DECIMAL(18,6)`. The per-order unique amount is `total_usdc + (counter × 0.000001)`.
The counter comes from `merchant_config.order_counter` (0–99, incremented atomically, wraps):
```sql
INSERT INTO merchant_config (key, value, updated_at)
VALUES ('order_counter', '0', NOW())
ON CONFLICT (key) DO UPDATE
  SET value = ((merchant_config.value::int + 1) % 100)::text, updated_at = NOW()
RETURNING value
```

### Key indexes
- `idx_orders_status` on `orders(status)` — for polling pending orders
- `idx_orders_adjusted_total` on `orders(adjusted_total_usdc)` — for deposit matching
- `idx_orders_transaction_id` on `orders(transaction_id)` — dedup check

### merchant_config
Key-value store for runtime configuration. All values are TEXT.
Write via `upsertConfig(key, value)` in `bootstrap.ts`.
Do not hard-code these values anywhere — always read from DB at runtime.
