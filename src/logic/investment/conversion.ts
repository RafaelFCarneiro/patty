import type { AccountAfterDeletion, AccountConversion } from '../../models/investment/core.js';

export const afterOpening = (account: AccountConversion, remainingCash: number): AccountConversion => ({
  initialBalance: remainingCash,
  cashBeforeHoldings:
    account.cashBeforeHoldings ?? (account.initialBalance === remainingCash ? null : account.initialBalance),
});

export const isLastEvent = (events: readonly { id: string }[], eventId: string): boolean =>
  events.every((event) => event.id === eventId);

export const afterDeletion = (account: AccountConversion, isLast: boolean): AccountAfterDeletion =>
  isLast && account.cashBeforeHoldings !== null
    ? { initialBalance: account.cashBeforeHoldings, cashBeforeHoldings: null, restored: true }
    : { ...account, restored: false };
