/**
 * Integration tests against the live deployed API.
 *
 * These tests hit the real Railway endpoint. Run with:
 *   npm run test:integration
 *
 * Set BASE_URL env var to test against a local server instead:
 *   BASE_URL=http://localhost:3000 npm run test:integration
 */

const BASE_URL = process.env.BASE_URL ?? 'https://muralpay-marketplace-production.up.railway.app';

// Increase timeout for network requests
jest.setTimeout(15_000);

// ─── Products ─────────────────────────────────────────────────────────────────

describe('GET /products', () => {
  it('returns exactly 5 active products', async () => {
    const res = await fetch(`${BASE_URL}/products`);
    expect(res.status).toBe(200);
    const body = await res.json() as { products: unknown[] };
    expect(body.products).toHaveLength(5);
  });

  it('each product has required fields', async () => {
    const res = await fetch(`${BASE_URL}/products`);
    const body = await res.json() as { products: Array<{ id: string; name: string; price_usdc: number; active: boolean }> };
    for (const p of body.products) {
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof p.name).toBe('string');
      expect(typeof p.price_usdc).toBe('number');
      expect(p.active).toBe(true);
    }
  });
});

// ─── Orders ───────────────────────────────────────────────────────────────────

const COFFEE_BAG_ID = 'a1000000-0000-0000-0000-000000000001'; // price: 12 USDC

describe('POST /orders', () => {
  it('creates an order and returns payment instructions', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: COFFEE_BAG_ID,
        customer_name: 'Integration Test',
        customer_email: 'test@integration.com',
        quantity: 1,
      }),
    });
    expect(res.status).toBe(201);

    const body = await res.json() as {
      order: { id: string; status: string; total_usdc: number };
      payment_instructions: { amount_usdc: number; wallet_address: string; token: string };
    };

    expect(body.order.status).toBe('pending');
    expect(body.order.total_usdc).toBe(12);
    expect(body.payment_instructions.token).toBe('USDC');
    expect(body.payment_instructions.wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Adjusted amount is base + 0.01–0.99
    expect(body.payment_instructions.amount_usdc).toBeGreaterThan(12);
    expect(body.payment_instructions.amount_usdc).toBeLessThan(13);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: COFFEE_BAG_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('required');
  });

  it('returns 400 for quantity = 0', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: COFFEE_BAG_ID,
        customer_name: 'Test',
        customer_email: 't@t.com',
        quantity: 0,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative quantity', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: COFFEE_BAG_ID,
        customer_name: 'Test',
        customer_email: 't@t.com',
        quantity: -1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for fractional quantity', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: COFFEE_BAG_ID,
        customer_name: 'Test',
        customer_email: 't@t.com',
        quantity: 1.5,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown product ID', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: '00000000-0000-0000-0000-000000000000',
        customer_name: 'Test',
        customer_email: 't@t.com',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('calculates correct total for quantity > 1', async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: COFFEE_BAG_ID,
        customer_name: 'Bulk Buyer',
        customer_email: 'bulk@test.com',
        quantity: 3,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { order: { total_usdc: number } };
    expect(body.order.total_usdc).toBe(36); // 12 × 3
  });
});

describe('GET /orders/:id', () => {
  let orderId: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: COFFEE_BAG_ID,
        customer_name: 'Fetch Test',
        customer_email: 'fetch@test.com',
      }),
    });
    const body = await res.json() as { order: { id: string } };
    orderId = body.order.id;
  });

  it('returns the order with all expected fields', async () => {
    const res = await fetch(`${BASE_URL}/orders/${orderId}`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      order: {
        id: string; status: string; total_usdc: number;
        payment_amount_usdc: number; deposit_wallet_address: string;
        product: { id: string; name: string };
      };
    };

    expect(body.order.id).toBe(orderId);
    expect(body.order.status).toBe('pending');
    expect(body.order.payment_amount_usdc).toBeGreaterThan(12);
    expect(body.order.deposit_wallet_address).toMatch(/^0x/);
    expect(body.order.product.name).toBe('Artisan Coffee Bag');
  });

  it('returns 404 for unknown order ID', async () => {
    const res = await fetch(`${BASE_URL}/orders/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });
});

// ─── Merchant endpoints ───────────────────────────────────────────────────────

describe('GET /merchant/orders', () => {
  it('returns a list of orders', async () => {
    const res = await fetch(`${BASE_URL}/merchant/orders`);
    expect(res.status).toBe(200);
    const body = await res.json() as { orders: unknown[] };
    expect(Array.isArray(body.orders)).toBe(true);
    expect(body.orders.length).toBeGreaterThan(0);
  });

  it('each order has status and customer_name', async () => {
    const res = await fetch(`${BASE_URL}/merchant/orders`);
    const body = await res.json() as { orders: Array<{ status: string; customer_name: string }> };
    for (const o of body.orders) {
      expect(typeof o.status).toBe('string');
      expect(typeof o.customer_name).toBe('string');
    }
  });
});

describe('GET /merchant/withdrawals', () => {
  it('returns a list (may be empty)', async () => {
    const res = await fetch(`${BASE_URL}/merchant/withdrawals`);
    expect(res.status).toBe(200);
    const body = await res.json() as { withdrawals: unknown[] };
    expect(Array.isArray(body.withdrawals)).toBe(true);
  });
});

describe('GET /merchant/account', () => {
  it('returns account with balance and wallet address', async () => {
    const res = await fetch(`${BASE_URL}/merchant/account`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      account: {
        status: string;
        isApiEnabled: boolean;
        accountDetails: { walletDetails: { walletAddress: string }; balances: unknown[] };
      };
    };

    expect(body.account.status).toBe('ACTIVE');
    expect(body.account.isApiEnabled).toBe(true);
    expect(body.account.accountDetails.walletDetails.walletAddress).toMatch(/^0x/);
    expect(body.account.accountDetails.balances.length).toBeGreaterThan(0);
  });
});

// ─── Health & Misc ────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${BASE_URL}/unknown-route-xyz`);
    expect(res.status).toBe(404);
  });
});
