import type { AccountAfterDeletion, AccountConversion } from '../../models/investment/core.js';

export const afterOpening = (account: AccountConversion, remainingCash: number): AccountConversion => ({
  initialBalance: remainingCash,
  cashBeforeHoldings:
    account.cashBeforeHoldings ?? (account.initialBalance === remainingCash ? null : account.initialBalance),
});

export const afterDeletion = (account: AccountConversion, isLastEvent: boolean): AccountAfterDeletion =>
  isLastEvent && account.cashBeforeHoldings !== null
    ? { initialBalance: account.cashBeforeHoldings, cashBeforeHoldings: null, restored: true }
    : { ...account, restored: false };
