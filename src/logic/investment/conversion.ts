import type { PendingParts } from '../../models/account.js';
import type { AccountAfterDeletion, AccountConversion } from '../../models/investment/core.js';
import { roundToDecimals } from '../money.js';

export const netMovement = (parts: PendingParts): number =>
  parts.income - parts.expenses + parts.transfersIn - parts.transfersOut;

export const afterOpening = (
  account: AccountConversion,
  remainingCash: number,
  movements: PendingParts,
  decimals: number,
): AccountConversion => {
  const initialBalance = roundToDecimals(remainingCash - netMovement(movements), decimals);
  return {
    initialBalance,
    cashBeforeHoldings:
      account.cashBeforeHoldings ?? (account.initialBalance === initialBalance ? null : account.initialBalance),
  };
};

export const isLastEvent = (events: readonly { id: string }[], eventId: string): boolean =>
  events.every((event) => event.id === eventId);

export const afterDeletion = (account: AccountConversion, isLast: boolean): AccountAfterDeletion =>
  isLast && account.cashBeforeHoldings !== null
    ? { initialBalance: account.cashBeforeHoldings, cashBeforeHoldings: null, restored: true }
    : { ...account, restored: false };
