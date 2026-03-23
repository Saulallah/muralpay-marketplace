import { pool } from './index';

const MIGRATION = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price_usdc DECIMAL(18,6) NOT NULL,
  image_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price_usdc DECIMAL(18,6) NOT NULL,
  total_usdc DECIMAL(18,6) NOT NULL,
  -- Slightly adjusted amount to help uniquely identify incoming deposits
  adjusted_total_usdc DECIMAL(18,6) NOT NULL,
  deposit_wallet_address TEXT NOT NULL,
  mural_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending | paid | processing_withdrawal | withdrawn | failed
  transaction_hash TEXT,
  transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  mural_payout_request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending | processing | completed | failed
  amount_usdc DECIMAL(18,6) NOT NULL,
  counterparty_id TEXT NOT NULL,
  payout_method_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stores key-value config like account IDs, counterparty IDs, webhook IDs, order counter
CREATE TABLE IF NOT EXISTS merchant_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast order matching by adjusted amount + status
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_adjusted_total ON orders(adjusted_total_usdc);
CREATE INDEX IF NOT EXISTS idx_orders_transaction_id ON orders(transaction_id);
`;

const SEED_PRODUCTS = `
INSERT INTO products (name, description, price_usdc, image_url)
VALUES
  ('Artisan Coffee Bag', 'Premium single-origin Colombian coffee, 250g', 12.00, 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400'),
  ('Handwoven Mochila Bag', 'Authentic wayuu handwoven bag from La Guajira', 45.00, 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=400'),
  ('Colombian Emerald Pendant', 'Certified natural Colombian emerald pendant', 120.00, 'https://images.unsplash.com/photo-1611591437281-460bfbe1220a?w=400'),
  ('Exotic Fruit Bundle', 'Seasonal exotic fruits: lulo, maracuya, guanabana', 8.00, 'https://images.unsplash.com/photo-1519996529931-28324d5a630e?w=400'),
  ('Leather Wallet', 'Handcrafted leather wallet from Bogota artisans', 35.00, 'https://images.unsplash.com/photo-1627123424574-724758594e93?w=400')
ON CONFLICT DO NOTHING;
`;

/**
 * Creates all database tables (if they don't exist) and seeds the products table
 * with 5 sample Colombian marketplace products. Safe to run multiple times —
 * all DDL uses IF NOT EXISTS and the seed uses ON CONFLICT DO NOTHING.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running database migration...');
    await client.query(MIGRATION);
    console.log('Migration complete.');
    console.log('Seeding products...');
    await client.query(SEED_PRODUCTS);
    console.log('Seed complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
