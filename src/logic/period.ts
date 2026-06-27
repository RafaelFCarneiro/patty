import { isNonNullish } from 'remeda'
import type { IsoDate, Period } from '../models/date.js'

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

type PeriodInput = { month?: number | null; year?: number | null; from?: IsoDate | null; to?: IsoDate | null }

export const hasPeriod = (input: PeriodInput): boolean =>
  isNonNullish(input.month) && isNonNullish(input.year)

export const hasDateRange = (input: PeriodInput): boolean =>
  isNonNullish(input.from) || isNonNullish(input.to)

export const assertHasPeriodOrRange = (input: PeriodInput): boolean =>
  hasPeriod(input) || hasDateRange(input)

type NullableDateRange = { from: string | null; to: string | null }

export const resolveDateRange = (input: PeriodInput): NullableDateRange => {
  const range = hasPeriod(input) ? periodRange({ month: input.month!, year: input.year! }) : null
  return {
    from: range?.from ?? input.from ?? null,
    to: range?.to ?? input.to ?? null,
  }
}
