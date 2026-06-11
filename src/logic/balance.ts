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
