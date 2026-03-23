/**
 * Unit tests for paymentProcessor business logic.
 *
 * These tests do NOT hit the database or Mural API — they test
 * pure logic by mocking dependencies.
 */

// Mock the db module before importing paymentProcessor
jest.mock('../../src/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('../../src/services/muralPay', () => ({
  createPayoutRequest: jest.fn(),
  executePayoutRequest: jest.fn(),
  getPayoutRequest: jest.fn(),
}));

import { query, queryOne } from '../../src/db';
import * as mural from '../../src/services/muralPay';
import { matchAndProcessDeposit, initiateWithdrawal, syncWithdrawalStatuses } from '../../src/services/paymentProcessor';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockCreatePayout = mural.createPayoutRequest as jest.MockedFunction<typeof mural.createPayoutRequest>;
const mockExecutePayout = mural.executePayoutRequest as jest.MockedFunction<typeof mural.executePayoutRequest>;
const mockGetPayout = mural.getPayoutRequest as jest.MockedFunction<typeof mural.getPayoutRequest>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTx(overrides: Partial<mural.MuralTransaction> = {}): mural.MuralTransaction {
  return {
    id: 'tx-001',
    hash: '0xabc123',
    transactionExecutionDate: new Date().toISOString(),
    blockchain: 'POLYGON',
    amount: { tokenAmount: 12.05, tokenSymbol: 'USDC' },
    accountId: 'account-001',
    counterpartyInfo: null,
    transactionDetails: { type: 'payout', details: { type: 'crypto', senderAddress: '0xSENDER' } },
    ...overrides,
  };
}

function makeOrder(overrides: object = {}) {
  return {
    id: 'order-001',
    product_id: 'prod-001',
    customer_name: 'Test Customer',
    customer_email: 'test@example.com',
    quantity: 1,
    unit_price_usdc: '12.00',
    total_usdc: '12.00',
    adjusted_total_usdc: '12.05',
    deposit_wallet_address: '0xMARKETPLACE',
    mural_account_id: 'account-001',
    status: 'pending',
    transaction_hash: null,
    transaction_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── matchAndProcessDeposit ───────────────────────────────────────────────────

describe('matchAndProcessDeposit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips transactions with unrecognised type', async () => {
    const tx = makeTx({ transactionDetails: { type: 'unknown' } });
    await matchAndProcessDeposit(tx);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('skips payout transactions originating from our own wallet', async () => {
    const tx = makeTx({
      transactionDetails: { type: 'payout', details: { type: 'crypto', senderAddress: '0xMARKETPLACE' } },
    });
    // wallet_address lookup returns our own wallet
    mockQueryOne.mockResolvedValueOnce({ value: '0xMARKETPLACE' });
    await matchAndProcessDeposit(tx);
    // Should stop after the wallet check — no dedup query
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('skips already-processed transactions (dedup check)', async () => {
    const tx = makeTx();
    mockQueryOne
      .mockResolvedValueOnce({ value: '0xOTHER' })     // wallet_address (different = incoming)
      .mockResolvedValueOnce({ id: 'order-001' });      // existing order with this transaction_id
    await matchAndProcessDeposit(tx);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('logs no-match when no pending order found', async () => {
    const tx = makeTx();
    mockQueryOne
      .mockResolvedValueOnce({ value: '0xOTHER' })  // wallet_address
      .mockResolvedValueOnce(null);                   // dedup: no existing order
    mockQuery.mockResolvedValueOnce([]);               // no matching pending orders

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await matchAndProcessDeposit(tx);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No matching pending order'));
    consoleSpy.mockRestore();
  });

  it('marks order as paid and triggers withdrawal on match', async () => {
    const tx = makeTx();
    const order = makeOrder();

    mockQueryOne
      .mockResolvedValueOnce({ value: '0xOTHER' })   // wallet_address
      .mockResolvedValueOnce(null);                    // dedup: no existing order

    mockQuery
      .mockResolvedValueOnce([order])                  // matching pending order
      .mockResolvedValueOnce([{ id: order.id }]);      // UPDATE RETURNING id (success)

    // Mock the withdrawal to succeed silently
    mockQueryOne
      .mockResolvedValueOnce({ value: 'cp-001' })      // counterparty_id
      .mockResolvedValueOnce({ value: 'pm-001' });     // payout_method_id
    mockQuery
      .mockResolvedValueOnce([])                       // UPDATE to processing_withdrawal
      .mockResolvedValueOnce([]);                      // INSERT withdrawal
    mockCreatePayout.mockResolvedValueOnce({ id: 'payout-001', status: 'AWAITING_EXECUTION', sourceAccountId: 'acc', payouts: [], createdAt: '', updatedAt: '' });
    mockExecutePayout.mockResolvedValueOnce({ id: 'payout-001', status: 'EXECUTED', sourceAccountId: 'acc', payouts: [], createdAt: '', updatedAt: '' });
    mockQuery
      .mockResolvedValueOnce([])                       // UPDATE withdrawal status
      .mockResolvedValueOnce([]);                      // UPDATE order to withdrawn

    await matchAndProcessDeposit(tx);

    // The UPDATE with RETURNING should have been called with the right args
    const updateCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes("status = 'paid'")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(['0xabc123', 'tx-001', 'order-001']);
  });

  it('skips if another process already claimed the order (concurrent race)', async () => {
    const tx = makeTx();
    const order = makeOrder();

    mockQueryOne
      .mockResolvedValueOnce({ value: '0xOTHER' })
      .mockResolvedValueOnce(null);
    mockQuery
      .mockResolvedValueOnce([order])   // found a matching order
      .mockResolvedValueOnce([]);        // UPDATE RETURNING returns nothing (already claimed)

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await matchAndProcessDeposit(tx);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already claimed'));
    consoleSpy.mockRestore();
  });

  it('accepts deposit type without wallet address check', async () => {
    const tx = makeTx({ transactionDetails: { type: 'deposit' } });
    mockQueryOne.mockResolvedValueOnce(null);   // dedup: no existing order
    mockQuery.mockResolvedValueOnce([]);         // no matching orders

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await matchAndProcessDeposit(tx);
    // Should reach the "no match" log without querying wallet_address
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No matching pending order'));
    consoleSpy.mockRestore();
  });
});

// ─── Payout status mapping ────────────────────────────────────────────────────

// Access the private functions via module re-export trick — we test their effects
// through syncWithdrawalStatuses instead.

describe('syncWithdrawalStatuses', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks withdrawal completed and order withdrawn when Mural status is EXECUTED', async () => {
    mockQuery.mockResolvedValueOnce([
      { id: 'wd-001', mural_payout_request_id: 'pr-001' },
    ]);
    mockGetPayout.mockResolvedValueOnce({
      id: 'pr-001', status: 'EXECUTED', sourceAccountId: 'acc', payouts: [], createdAt: '', updatedAt: '',
    });
    mockQuery
      .mockResolvedValueOnce([])  // UPDATE withdrawals SET status = 'completed'
      .mockResolvedValueOnce([]);  // UPDATE orders SET status = 'withdrawn'

    await syncWithdrawalStatuses();

    const withdrawalUpdate = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE withdrawals')
    );
    expect(withdrawalUpdate![1]![0]).toBe('completed');
  });

  it('maps FAILED status to failed', async () => {
    mockQuery.mockResolvedValueOnce([
      { id: 'wd-001', mural_payout_request_id: 'pr-001' },
    ]);
    mockGetPayout.mockResolvedValueOnce({
      id: 'pr-001', status: 'FAILED', sourceAccountId: 'acc', payouts: [], createdAt: '', updatedAt: '',
    });
    mockQuery.mockResolvedValueOnce([]);  // UPDATE withdrawals

    await syncWithdrawalStatuses();

    const withdrawalUpdate = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE withdrawals')
    );
    expect(withdrawalUpdate![1]![0]).toBe('failed');
  });

  it('continues processing other withdrawals if one fails', async () => {
    mockQuery.mockResolvedValueOnce([
      { id: 'wd-001', mural_payout_request_id: 'pr-001' },
      { id: 'wd-002', mural_payout_request_id: 'pr-002' },
    ]);
    mockGetPayout
      .mockRejectedValueOnce(new Error('Mural API down'))
      .mockResolvedValueOnce({ id: 'pr-002', status: 'PENDING', sourceAccountId: 'acc', payouts: [], createdAt: '', updatedAt: '' });
    mockQuery.mockResolvedValueOnce([]);  // UPDATE for wd-002

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await syncWithdrawalStatuses();
    // wd-001 failed but wd-002 was still processed
    expect(mockGetPayout).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});

// ─── initiateWithdrawal ───────────────────────────────────────────────────────

describe('initiateWithdrawal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws if merchant config is missing', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)  // counterparty_id missing
      .mockResolvedValueOnce(null);

    await expect(initiateWithdrawal('order-001', 'account-001', 12.05))
      .rejects.toThrow('Merchant counterparty/payout method not configured');
  });

  it('reverts order to paid if payout creation fails', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ value: 'cp-001' })
      .mockResolvedValueOnce({ value: 'pm-001' });
    mockQuery.mockResolvedValueOnce([]);  // UPDATE to processing_withdrawal
    mockCreatePayout.mockRejectedValueOnce(new Error('Mural error'));
    mockQuery.mockResolvedValueOnce([]);  // revert UPDATE to paid

    await expect(initiateWithdrawal('order-001', 'account-001', 12.05))
      .rejects.toThrow('Mural error');

    const revertCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes("status = 'paid'")
    );
    expect(revertCall).toBeDefined();
  });
});
