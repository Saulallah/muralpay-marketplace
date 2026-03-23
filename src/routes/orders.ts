import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db';

const router = Router();

interface Product {
  id: string;
  name: string;
  price_usdc: string;
  active: boolean;
}

interface Order {
  id: string;
  product_id: string;
  customer_name: string;
  customer_email: string;
  quantity: number;
  unit_price_usdc: string;
  total_usdc: string;
  adjusted_total_usdc: string;
  deposit_wallet_address: string;
  mural_account_id: string;
  status: string;
  transaction_hash: string | null;
  transaction_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Allocate a unique adjusted amount for an order by using an atomic counter.
 * Adds a tiny fractional increment (0.000001 * counter) to base amount so that
 * each pending order has a slightly different total — enabling deposit matching.
 *
 * Counter wraps at 99 to keep the adjustment < 0.0001 USDC.
 */
async function allocateAdjustedAmount(baseAmount: number): Promise<number> {
  // Atomically increment and get counter
  await query(`
    INSERT INTO merchant_config (key, value, updated_at)
    VALUES ('order_counter', '1', NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = (CAST(merchant_config.value AS INT) % 99 + 1)::TEXT,
          updated_at = NOW()
  `);
  const row = await queryOne<{ value: string }>('SELECT value FROM merchant_config WHERE key = $1', ['order_counter']);
  const counter = parseInt(row?.value ?? '1', 10);
  // Add counter * 0.01 USDC (1 cent steps) — keeps amounts to 2 decimal places
  // so customers can send the exact amount via any wallet or exchange UI.
  return Math.round((baseAmount + counter * 0.01) * 100) / 100;
}

/**
 * POST /orders
 * Create a new order and return payment instructions.
 *
 * Body: { product_id, quantity, customer_name, customer_email }
 */
router.post('/', async (req: Request, res: Response) => {
  const { product_id, quantity = 1, customer_name, customer_email } = req.body as {
    product_id?: string;
    quantity?: number;
    customer_name?: string;
    customer_email?: string;
  };

  if (!product_id || !customer_name || !customer_email) {
    res.status(400).json({ error: 'product_id, customer_name, and customer_email are required' });
    return;
  }

  if (!Number.isInteger(Number(quantity)) || Number(quantity) < 1) {
    res.status(400).json({ error: 'quantity must be a positive integer' });
    return;
  }

  try {
    // Look up product
    const product = await queryOne<Product>(
      'SELECT * FROM products WHERE id = $1 AND active = true',
      [product_id]
    );
    if (!product) {
      res.status(404).json({ error: 'Product not found or inactive' });
      return;
    }

    // Get merchant account info from config
    const accountIdRow = await queryOne<{ value: string }>(
      'SELECT value FROM merchant_config WHERE key = $1',
      ['mural_account_id']
    );
    const walletAddressRow = await queryOne<{ value: string }>(
      'SELECT value FROM merchant_config WHERE key = $1',
      ['wallet_address']
    );

    if (!accountIdRow || !walletAddressRow) {
      res.status(503).json({ error: 'Merchant account not yet initialized. Please try again shortly.' });
      return;
    }

    const unitPrice = parseFloat(product.price_usdc);
    const totalUsdc = Math.round(unitPrice * Number(quantity) * 1_000_000) / 1_000_000;
    const adjustedTotal = await allocateAdjustedAmount(totalUsdc);

    const [order] = await query<Order>(
      `INSERT INTO orders
         (product_id, customer_name, customer_email, quantity, unit_price_usdc,
          total_usdc, adjusted_total_usdc, deposit_wallet_address, mural_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        product_id,
        customer_name,
        customer_email,
        quantity,
        unitPrice,
        totalUsdc,
        adjustedTotal,
        walletAddressRow.value,
        accountIdRow.value,
      ]
    );

    res.status(201).json({
      order: {
        id: order.id,
        status: order.status,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        product: { id: product.id, name: product.name },
        quantity: order.quantity,
        unit_price_usdc: parseFloat(order.unit_price_usdc),
        total_usdc: parseFloat(order.total_usdc),
        created_at: order.created_at,
      },
      payment_instructions: {
        message: 'Send exactly the specified USDC amount to the wallet address on the Polygon network.',
        network: 'Polygon (AMOY testnet in sandbox)',
        token: 'USDC',
        wallet_address: order.deposit_wallet_address,
        // The customer MUST send this exact adjusted amount for proper matching
        amount_usdc: parseFloat(order.adjusted_total_usdc),
        warning: 'Send the exact amount shown. A different amount may result in a failed or mismatched payment.',
      },
    });
  } catch (err) {
    console.error('[Orders] POST /', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

/**
 * GET /orders/:id
 * Get a single order by ID.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const order = await queryOne<Order & { product_name: string }>(
      `SELECT o.*, p.name as product_name
       FROM orders o
       JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.json({
      order: {
        id: order.id,
        status: order.status,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        product: { id: order.product_id, name: order.product_name },
        quantity: order.quantity,
        unit_price_usdc: parseFloat(order.unit_price_usdc),
        total_usdc: parseFloat(order.total_usdc),
        payment_amount_usdc: parseFloat(order.adjusted_total_usdc),
        deposit_wallet_address: order.deposit_wallet_address,
        transaction_hash: order.transaction_hash,
        created_at: order.created_at,
        updated_at: order.updated_at,
      },
    });
  } catch (err) {
    console.error('[Orders] GET /:id', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

export default router;
