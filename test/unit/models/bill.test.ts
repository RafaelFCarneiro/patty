import { describe, expect, it } from 'vitest'
import { BillQuerySchema, BillSchema, PayBillSchema } from '../../../src/models/bill.js'
import { BillQuery as WireBillQuery, PayBill as WirePayBill } from '../../../src/wire/in/bills.js'

describe('BillSchema', () => {
  it('parses a valid bill', () => {
    const result = BillSchema.safeParse({
      id: 'b1',
      month: 6,
      year: 2025,
      closeDate: '2025-06-28',
      dueDate: '2025-07-05',
      status: 'open',
    })
    expect(result.success).toBe(true)
  })

  it('rejects month outside 1–12', () => {
    expect(BillSchema.safeParse({ id: 'b1', month: 0, year: 2025, closeDate: '2025-06-28', dueDate: '2025-07-05', status: 'open' }).success).toBe(false)
    expect(BillSchema.safeParse({ id: 'b1', month: 13, year: 2025, closeDate: '2025-06-28', dueDate: '2025-07-05', status: 'open' }).success).toBe(false)
  })

  it('rejects year outside 2000–2100', () => {
    expect(BillSchema.safeParse({ id: 'b1', month: 1, year: 1999, closeDate: '2025-01-28', dueDate: '2025-02-05', status: 'open' }).success).toBe(false)
    expect(BillSchema.safeParse({ id: 'b1', month: 1, year: 2101, closeDate: '2025-01-28', dueDate: '2025-02-05', status: 'open' }).success).toBe(false)
  })
})

describe('BillQuerySchema (model — strict typed numbers)', () => {
  it('accepts valid query', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 6, year: 2025 }).success).toBe(true)
  })

  it('rejects string month (no coercion at model layer)', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: '6', year: 2025 }).success).toBe(false)
  })

  it('rejects out-of-range month', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 0, year: 2025 }).success).toBe(false)
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 13, year: 2025 }).success).toBe(false)
  })

  it('rejects out-of-range year', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 6, year: 1999 }).success).toBe(false)
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 6, year: 2101 }).success).toBe(false)
  })

  it('rejects empty card', () => {
    expect(BillQuerySchema.safeParse({ card: '', month: 6, year: 2025 }).success).toBe(false)
  })
})

describe('PayBillSchema (model — extends BillQuerySchema)', () => {
  it('accepts without account', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025 }).success).toBe(true)
  })

  it('accepts with account', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025, account: 'Itaú' }).success).toBe(true)
  })

  it('rejects empty account string', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025, account: '' }).success).toBe(false)
  })
})

describe('Wire BillQuery (REST boundary — coerces strings)', () => {
  it('coerces string month/year from query params', () => {
    const result = WireBillQuery.safeParse({ card: 'Nubank', month: '6', year: '2025' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.month).toBe(6)
      expect(result.data.year).toBe(2025)
    }
  })

  it('still accepts typed numbers', () => {
    expect(WireBillQuery.safeParse({ card: 'Nubank', month: 6, year: 2025 }).success).toBe(true)
  })

  it('rejects out-of-range after coercion', () => {
    expect(WireBillQuery.safeParse({ card: 'Nubank', month: '13', year: '2025' }).success).toBe(false)
    expect(WireBillQuery.safeParse({ card: 'Nubank', month: '6', year: '1999' }).success).toBe(false)
  })
})

describe('Wire PayBill (REST boundary — coerces strings)', () => {
  it('coerces month/year and keeps optional account', () => {
    const result = WirePayBill.safeParse({ card: 'Nubank', month: '6', year: '2025', account: 'Itaú' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.month).toBe(6)
      expect(result.data.account).toBe('Itaú')
    }
  })
})
