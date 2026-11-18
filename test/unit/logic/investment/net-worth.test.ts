import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../../src/models/money.js';
import {
  accountHoldings,
  holdingsTotalsByAccount,
  netWorthHoldings,
  withAccountHoldings,
  withNetWorthHoldings,
} from '../../../../src/logic/investment/net-worth.js';
import { valuePosition } from '../../../../src/logic/investment/valuation.js';
import { FRESH, investmentAccount, nuAsset, priceOf, valuationContext } from '../../fixtures/investment.js';

const { BRL } = CurrencyCode.enum;

describe('holdings in balances and net worth (ADR-038 §6)', () => {
  const account = investmentAccount();
  const nu = nuAsset();
  const valuation = valuePosition(
    {
      position: { accountId: 'acc-inv', assetId: nu.id, quantity: 10, avgCost: 8 },
      account,
      asset: nu,
      price: priceOf(nu, 13, FRESH),
    },
    valuationContext(),
  );
  const unpriced = valuePosition(
    {
      position: { accountId: 'acc-other', assetId: nu.id, quantity: 1, avgCost: 8 },
      account: investmentAccount({ id: 'acc-other', name: 'Other' }),
      asset: nu,
      price: undefined,
    },
    valuationContext(),
  );

  it('totals each account’s positions on their own', () => {
    const totals = holdingsTotalsByAccount([valuation, unpriced], BRL, 2);
    expect(totals['acc-inv']).toMatchObject({ marketValue: 650 });
    expect(totals['acc-other']).toMatchObject({ marketValue: 0, excluded: [{ reason: 'no_price' }] });
  });

  it('adds holdings only to an account that holds positions, leaving the others exactly as they were', () => {
    const plain = { id: 'acc-plain', balance: 10 };
    const invested = { id: 'acc-inv', balance: 100, converted: { value: 500 } };
    const [first, second] = withAccountHoldings([plain, invested], [valuation], BRL, 2);
    expect(first).toBe(plain);
    expect(second?.holdings).toEqual({
      cashBalance: 100,
      holdingsValue: 650,
      baseCurrency: BRL,
      total: 1150,
      stale: false,
      asOf: FRESH,
      excluded: [],
    });
  });

  it('has no total when the cash cannot be converted, but still reports the holdings', () => {
    const [entry] = withAccountHoldings([{ id: 'acc-inv', balance: 100 }], [valuation], BRL, 2);
    expect(entry?.holdings).toMatchObject({ total: null, holdingsValue: 650 });
    expect(accountHoldings(5, undefined, holdingsTotalsByAccount([valuation], BRL, 2)['acc-inv']!, 2).total).toBeNull();
  });

  it('adds the holdings to the net worth total and itemizes them; with none it is the same object', () => {
    const netWorth = { baseCurrency: BRL, total: 500, excluded: ['acc-x'] };
    const holdings = netWorthHoldings([valuation, unpriced], BRL, 2);
    expect(holdings).toMatchObject({ value: 650, stale: false, excluded: [{ asset: 'NYSE:NU', reason: 'no_price' }] });
    expect(withNetWorthHoldings(netWorth, holdings, 2)).toEqual({ ...netWorth, total: 1150, holdings });
    expect(netWorthHoldings([], BRL, 2)).toBeUndefined();
    expect(withNetWorthHoldings(netWorth, undefined, 2)).toBe(netWorth);
  });
});
