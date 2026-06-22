import { describe, expect, it } from 'vitest'
import { CurrencyCode } from '../../../src/models/common.js'
import { Locale } from '../../../src/models/locale.js'
import { RecurringPeriod, type RecurringRuleView } from '../../../src/models/recurring.js'
import { nextDue, recurringIdempotencyKey, withPeriodLabel } from '../../../src/logic/recurring.js'

describe('nextDue', () => {
  it('advances monthly, clamping short months', () => {
    expect(nextDue('2026-06-15', 'monthly')).toBe('2026-07-15')
    expect(nextDue('2026-01-31', 'monthly')).toBe('2026-02-28')
    expect(nextDue('2026-12-10', 'monthly')).toBe('2027-01-10')
  })

  it('advances weekly across month boundaries', () => {
    expect(nextDue('2026-06-28', 'weekly')).toBe('2026-07-05')
  })

  it('advances yearly, clamping Feb 29', () => {
    expect(nextDue('2028-02-29', 'yearly')).toBe('2029-02-28')
    expect(nextDue('2026-03-01', 'yearly')).toBe('2027-03-01')
  })
})

describe('recurringIdempotencyKey', () => {
  it('is stable per rule + due date', () => {
    expect(recurringIdempotencyKey('r1', '2026-06-01')).toBe('rec-r1-2026-06-01')
  })
})

const rule: RecurringRuleView = {
  id: 'rec-1',
  description: 'Rent',
  amount: 2000,
  type: 'expense',
  period: RecurringPeriod.enum.monthly,
  nextDue: '2026-07-01',
  currency: CurrencyCode.enum.BRL,
}

describe('withPeriodLabel', () => {
  it('adds periodLabel for the given locale (data-first)', () => {
    expect(withPeriodLabel(rule, Locale.enum.pt).periodLabel).toBe('Mensal')
  })

  it('works as data-last for pipes', () => {
    expect(withPeriodLabel(Locale.enum.es)(rule).periodLabel).toBe('Mensual')
  })

  it('preserves original period value', () => {
    expect(withPeriodLabel(rule, Locale.enum.pt).period).toBe(RecurringPeriod.enum.monthly)
  })

  it('labels weekly period', () => {
    const weekly: RecurringRuleView = { ...rule, period: RecurringPeriod.enum.weekly }
    expect(withPeriodLabel(weekly, Locale.enum.en).periodLabel).toBe('Weekly')
  })
})
