import { describe, expect, it } from 'vitest'
import { CurrencyCode } from '../../../src/models/common.js'
import { ClassificationMethod, TransactionSource, TransactionType, TransactionView } from '../../../src/models/transaction.js'
import { billPeriodFor, computeBillTotal } from '../../../src/logic/bill.js'

const tx = (type: TransactionType, amount: number): TransactionView =>
  TransactionView.parse({
    id: crypto.randomUUID(), description: 'test', amount, type,
    date: '2026-06-01', currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp, idempotencyKey: `k-${amount}-${type}`,
    classification: { method: ClassificationMethod.enum.none, confidence: 0 },
  })

describe('computeBillTotal', () => {
  const { expense, income, transfer } = TransactionType.enum

  it('sums expenses as positive', () => {
    expect(computeBillTotal([tx(expense, 100), tx(expense, 50)])).toBe(150)
  })

  it('subtracts income (refunds/credits) from the total', () => {
    expect(computeBillTotal([tx(expense, 100), tx(income, 30)])).toBe(70)
  })

  it('excludes transfers from the total', () => {
    expect(computeBillTotal([tx(expense, 100), tx(transfer, 200)])).toBe(100)
  })

  it('returns 0 for an empty bill', () => {
    expect(computeBillTotal([])).toBe(0)
  })
})

describe('billPeriodFor', () => {
  // card closes on the 20th, due on the 5th of the following month
  it('assigns transaction on/before closing day to current month bill', () => {
    expect(billPeriodFor('2026-06-15', 20, 5)).toEqual({
      month: 6,
      year: 2026,
      closeDate: '2026-06-20',
      dueDate: '2026-07-05',
    })
    expect(billPeriodFor('2026-06-20', 20, 5).month).toBe(6)
  })

  it('assigns transaction after closing day to next month bill', () => {
    expect(billPeriodFor('2026-06-21', 20, 5)).toEqual({
      month: 7,
      year: 2026,
      closeDate: '2026-07-20',
      dueDate: '2026-08-05',
    })
  })

  it('rolls December into January', () => {
    expect(billPeriodFor('2026-12-25', 20, 5)).toMatchObject({ month: 1, year: 2027, dueDate: '2027-02-05' })
  })

  it('keeps due date in same month when dueDay > closingDay', () => {
    // closes on the 5th, due on the 15th of the same month
    expect(billPeriodFor('2026-06-03', 5, 15)).toEqual({
      month: 6,
      year: 2026,
      closeDate: '2026-06-05',
      dueDate: '2026-06-15',
    })
  })
})
