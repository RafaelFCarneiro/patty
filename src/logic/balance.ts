/** Pure balance arithmetic: derived, never stored — cannot drift. */

export type BalanceParts = {
  initialBalance: number
  income: number
  expenses: number
  transfersIn: number
  transfersOut: number
}

export const computeBalance = (p: BalanceParts): number =>
  p.initialBalance + p.income - p.expenses + p.transfersIn - p.transfersOut

/** Pending movement only — the same parts as a balance minus the account's starting point. */
export type PendingParts = Omit<BalanceParts, 'initialBalance'>

/** Projected balance = effective balance + pending transactions dated ≤ asOf. Pure arithmetic. */
export const computeProjectedBalance = (effective: number, pending: PendingParts): number =>
  effective + pending.income - pending.expenses + pending.transfersIn - pending.transfersOut
