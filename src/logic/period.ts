import type { Period } from '../models/date.js'

export type DateRange = { from: string; to: string }

const pad = (n: number): string => String(n).padStart(2, '0')

/** Month period → half-open ISO date range [from, to). */
export const periodRange = ({ month, year }: Period): DateRange => {
  const from = `${year}-${pad(month)}-01`
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`
  return { from, to }
}

export const toIsoDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
