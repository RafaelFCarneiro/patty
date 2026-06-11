import { describe, expect, it } from 'vitest'
import { billPeriodFor } from './bill.js'

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
