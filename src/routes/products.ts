import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();

interface Product {
  id: string;
  name: string;
  description: string | null;
  price_usdc: string;
  image_url: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * GET /products
 * List all active products.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const products = await query<Product>(
      'SELECT * FROM products WHERE active = true ORDER BY created_at ASC'
    );
    res.json({ products });
  } catch (err) {
    console.error('[Products] GET /', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

/**
 * GET /products/:id
 * Get a single product by ID.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const product = await queryOne<Product>(
      'SELECT * FROM products WHERE id = $1 AND active = true',
      [req.params.id]
    );
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ product });
  } catch (err) {
    console.error('[Products] GET /:id', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

/**
 * POST /products
 * Create a new product (merchant-only, requires auth).
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const { name, description, price_usdc, image_url } = req.body as {
    name?: string;
    description?: string;
    price_usdc?: number;
    image_url?: string;
  };

  if (!name || !price_usdc || isNaN(Number(price_usdc)) || Number(price_usdc) <= 0) {
    res.status(400).json({ error: 'name and price_usdc (positive number) are required' });
    return;
  }

  try {
    const [product] = await query<Product>(
      `INSERT INTO products (name, description, price_usdc, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, description ?? null, price_usdc, image_url ?? null]
    );
    res.status(201).json({ product });
  } catch (err) {
    console.error('[Products] POST /', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

/**
 * DELETE /products/:id
 * Deactivate a product (merchant-only, requires auth).
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await query<Product>(
      `UPDATE products SET active = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ message: 'Product deactivated', product: result[0] });
  } catch (err) {
    console.error('[Products] DELETE /:id', err);
    res.status(500).json({ error: 'Failed to deactivate product' });
  }
});

export default router;
