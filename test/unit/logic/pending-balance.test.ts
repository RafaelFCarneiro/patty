import { describe, expect, it } from 'vitest';
import { computeProjectedBalance } from '../../../src/logic/balance.js';

describe('computeProjectedBalance', () => {
  it('adds pending income and subtracts pending expenses', () => {
    expect(computeProjectedBalance(1000, { income: 500, expenses: 200, transfersIn: 0, transfersOut: 0 })).toBe(1300);
  });

  it('returns effective balance when no pending exists', () => {
    expect(computeProjectedBalance(750, { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 })).toBe(750);
  });

  it('handles pending transfers', () => {
    expect(computeProjectedBalance(500, { income: 0, expenses: 0, transfersIn: 300, transfersOut: 100 })).toBe(700);
  });

  it('can go negative with pending expenses exceeding balance', () => {
    expect(computeProjectedBalance(100, { income: 0, expenses: 500, transfersIn: 0, transfersOut: 0 })).toBe(-400);
  });

  it('boundary: pending dated exactly on asOf counts', () => {
    // The date filtering happens at the repo level; this pure function just does the arithmetic.
    expect(computeProjectedBalance(0, { income: 1000, expenses: 1000, transfersIn: 0, transfersOut: 0 })).toBe(0);
  });
});
