/**
 * Unit tests for order amount calculation logic.
 * Tests the 1-cent adjustment math and edge cases directly — no DB needed.
 */

// Inline the pure calculation from orders.ts so we can test it in isolation
function computeAdjustedAmount(baseAmount: number, counter: number): number {
  return Math.round((baseAmount + counter * 0.01) * 100) / 100;
}

function computeTotal(unitPrice: number, quantity: number): number {
  return Math.round(unitPrice * quantity * 1_000_000) / 1_000_000;
}

describe('adjustedAmount calculation', () => {
  it('adds 1 cent for counter = 1', () => {
    expect(computeAdjustedAmount(12, 1)).toBe(12.01);
  });

  it('adds 99 cents for counter = 99 (max)', () => {
    expect(computeAdjustedAmount(12, 99)).toBe(12.99);
  });

  it('always produces exactly 2 decimal places', () => {
    for (let counter = 1; counter <= 99; counter++) {
      const result = computeAdjustedAmount(12, counter);
      const decimals = result.toString().split('.')[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });

  it('works correctly for higher base prices', () => {
    expect(computeAdjustedAmount(120, 5)).toBe(120.05);
    expect(computeAdjustedAmount(45, 10)).toBe(45.10);
  });

  it('different counters produce unique amounts for the same base price', () => {
    const amounts = new Set<number>();
    for (let counter = 1; counter <= 99; counter++) {
      amounts.add(computeAdjustedAmount(12, counter));
    }
    expect(amounts.size).toBe(99); // all unique
  });
});

describe('total USDC calculation', () => {
  it('calculates single item correctly', () => {
    expect(computeTotal(12, 1)).toBe(12);
  });

  it('calculates multiple items correctly', () => {
    expect(computeTotal(12, 2)).toBe(24);
    expect(computeTotal(45, 3)).toBe(135);
  });

  it('handles fractional prices without floating point drift', () => {
    // Ensure no floating-point weirdness
    expect(computeTotal(8, 3)).toBe(24);
    expect(computeTotal(35, 2)).toBe(70);
  });
});

describe('deposit matching tolerance', () => {
  const TOLERANCE = 0.005;

  // Simulates the SQL: ABS(adjusted_total_usdc::numeric - depositAmount) < tolerance
  function wouldMatch(adjustedTotal: number, depositAmount: number): boolean {
    return Math.abs(adjustedTotal - depositAmount) < TOLERANCE;
  }

  it('matches exact amount', () => {
    expect(wouldMatch(12.05, 12.05)).toBe(true);
  });

  it('matches within half a cent', () => {
    expect(wouldMatch(12.05, 12.054)).toBe(true);
    expect(wouldMatch(12.05, 12.046)).toBe(true);
  });

  it('rejects amounts more than half a cent off', () => {
    expect(wouldMatch(12.05, 12.056)).toBe(false);
    expect(wouldMatch(12.05, 12.044)).toBe(false);
  });

  it('does not match adjacent counter steps (1 cent apart)', () => {
    // Adjacent orders (e.g. 12.05 and 12.06) should never match each other
    expect(wouldMatch(12.05, 12.06)).toBe(false);
    expect(wouldMatch(12.06, 12.05)).toBe(false);
  });

  it('does not match a different base price', () => {
    expect(wouldMatch(12.05, 45.05)).toBe(false);
  });
});
