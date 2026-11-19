import { describe, expect, it } from 'vitest';
import * as conversion from '../../../../src/logic/investment/conversion.js';

const NONE = { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 };

describe('conversion.afterOpening — the account while it holds positions', () => {
  it('sets the cash that stays and remembers the cash it changed from', () => {
    expect(conversion.afterOpening({ initialBalance: 700, cashBeforeHoldings: null }, 85, NONE, 2)).toEqual({
      initialBalance: 85,
      cashBeforeHoldings: 700,
    });
  });

  it('remembers nothing when the cash does not change', () => {
    expect(conversion.afterOpening({ initialBalance: 85, cashBeforeHoldings: null }, 85, NONE, 2)).toEqual({
      initialBalance: 85,
      cashBeforeHoldings: null,
    });
  });

  it('keeps what is already remembered whatever later openings leave (a second opening from 85 to 0)', () => {
    expect(conversion.afterOpening({ initialBalance: 85, cashBeforeHoldings: 700 }, 0, NONE, 2)).toEqual({
      initialBalance: 0,
      cashBeforeHoldings: 700,
    });
  });

  it('remembers a cash of 0 as a value, not as nothing', () => {
    expect(
      conversion.afterOpening({ initialBalance: 0, cashBeforeHoldings: null }, 85, NONE, 2).cashBeforeHoldings,
    ).toBe(0);
  });
});

describe('conversion.afterOpening — remainingCash is the balance after, the account’s activity is offset', () => {
  const account = { initialBalance: 0, cashBeforeHoldings: null };

  it('offsets a transfer in: a balance of 1000 from a transfer ends at remainingCash 0', () => {
    const result = conversion.afterOpening(account, 0, { ...NONE, transfersIn: 1000 }, 2);
    expect(result).toEqual({ initialBalance: -1000, cashBeforeHoldings: 0 });
  });

  it('offsets income and expenses and transfers out: initialBalance = remainingCash − net', () => {
    const movements = { income: 300, expenses: 120.5, transfersIn: 50, transfersOut: 10 };
    expect(conversion.afterOpening({ initialBalance: 700, cashBeforeHoldings: null }, 85, movements, 2)).toEqual({
      initialBalance: -134.5,
      cashBeforeHoldings: 700,
    });
  });

  it('rounds the offset to the account currency’s decimals, not float noise', () => {
    const movements = { ...NONE, income: 0.1, expenses: 0.2 };
    expect(conversion.afterOpening(account, 0, movements, 2).initialBalance).toBe(0.1);
  });

  it('nets the movements', () => {
    expect(conversion.netMovement({ income: 5, expenses: 2, transfersIn: 4, transfersOut: 1 })).toBe(6);
  });
});

describe('conversion.afterDeletion — the cash comes back with the last event only', () => {
  it('the last event restores the remembered cash and forgets it', () => {
    expect(conversion.afterDeletion({ initialBalance: 85, cashBeforeHoldings: 700 }, true)).toEqual({
      initialBalance: 700,
      cashBeforeHoldings: null,
      restored: true,
    });
  });

  it('restores a remembered 0', () => {
    expect(conversion.afterDeletion({ initialBalance: 85, cashBeforeHoldings: 0 }, true)).toMatchObject({
      initialBalance: 0,
      restored: true,
    });
  });

  it('an event with others remaining restores nothing and leaves the account as it was', () => {
    expect(conversion.afterDeletion({ initialBalance: 85, cashBeforeHoldings: 700 }, false)).toEqual({
      initialBalance: 85,
      cashBeforeHoldings: 700,
      restored: false,
    });
  });

  it('the last event of an account that remembered nothing restores nothing', () => {
    expect(conversion.afterDeletion({ initialBalance: 85, cashBeforeHoldings: null }, true)).toEqual({
      initialBalance: 85,
      cashBeforeHoldings: null,
      restored: false,
    });
  });
});

describe('conversion.isLastEvent — whatever its type, the event that is alone on its account', () => {
  it('is true when the event is the only one on the account', () => {
    expect(conversion.isLastEvent([{ id: 'a' }], 'a')).toBe(true);
  });

  it('is false while any other event remains, of any type', () => {
    expect(conversion.isLastEvent([{ id: 'a' }, { id: 'b' }], 'a')).toBe(false);
    expect(conversion.isLastEvent([{ id: 'b' }, { id: 'a' }], 'a')).toBe(false);
  });

  it('is true for an account with no events listed: nothing else remains', () => {
    expect(conversion.isLastEvent([], 'a')).toBe(true);
  });
});
