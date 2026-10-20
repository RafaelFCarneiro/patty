import { BalanceParts, PendingParts } from '../models/account.js';


export const computeBalance = (p: BalanceParts): number =>
  p.initialBalance + p.income - p.expenses + p.transfersIn - p.transfersOut;

export const computeProjectedBalance = (effective: number, pending: PendingParts): number =>
  effective + pending.income - pending.expenses + pending.transfersIn - pending.transfersOut;
