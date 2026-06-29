import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/bills', () => {
  it('returns a bill for an existing card', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Bill Payer', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Bill Payer' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Bill charge', amount: 50, type: 'expense', date: '2026-06-05', idempotencyKey: 'bill-chg-1', card: 'Bill Card' } })
    const res = await inject({ method: 'GET', url: '/api/bills?card=Bill Card&month=6&year=2026' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('bill')
    expect(res.json().bill).toHaveProperty('id')
  })

  it('returns note on transaction rows', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Note Bill Payer', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Note Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Note Bill Payer' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Note bill tx', amount: 42, type: 'expense', date: '2026-06-05', card: 'Note Bill Card', idempotencyKey: 'note-bill-1', note: 'warranty' } })
    const res = await inject({ method: 'GET', url: '/api/bills?card=Note Bill Card&month=6&year=2026' })
    expect(res.json().transactions.some((tx: { note?: string }) => tx.note === 'warranty')).toBe(true)
  })

  it('coerces string month/year', async () => {
    const res = await inject({ method: 'GET', url: '/api/bills?card=Bill Card&month=6&year=2026' })
    expect(res.statusCode).toBe(200)
  })

  it('rejects month out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/bills?card=X&month=13&year=2026' })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown card bill', async () => {
    const res = await inject({ method: 'GET', url: '/api/bills?card=Nonexistent Bill Card&month=1&year=2026' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/bills/pay', () => {
  it('pays a bill, debits payer, credits card account', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Pay Bill Acc', type: 'checking', currency: 'USD', initialBalance: 5000 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Pay Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Pay Bill Acc' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Charge', amount: 300, type: 'expense', date: '2026-06-05', idempotencyKey: 'pay-bill-chg', card: 'Pay Bill Card' } })
    const res = await inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'Pay Bill Card', month: 6, year: 2026, account: 'Pay Bill Acc' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('paid')
    const balances = await inject({ method: 'GET', url: '/api/accounts/balances?account=Pay Bill Acc' })
    expect(balances.json()[0].balance).toBe(4700)
    const cardBal = await inject({ method: 'GET', url: '/api/accounts/balances?account=Card: Pay Bill Card' })
    expect(cardBal.json()[0].balance).toBe(0)
  })

  it('pay_bill without account and without card default returns 422', async () => {
    await inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'No Default Card', closingDay: 28, dueDay: 5, currency: 'USD' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'No def charge', amount: 50, type: 'expense', date: '2026-06-05', card: 'No Default Card', idempotencyKey: 'nodef-chg' } })
    const res = await inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'No Default Card', month: 6, year: 2026 } })
    expect(res.statusCode).toBe(422)
  })

  it('pay_bill with currency mismatch returns 422', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'BRL Mismatch Acc', type: 'checking', currency: 'BRL', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'USD Mismatch Card', closingDay: 28, dueDay: 5, currency: 'USD' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Mismatch chg', amount: 25, type: 'expense', date: '2026-06-05', card: 'USD Mismatch Card', idempotencyKey: 'mismatch-chg' } })
    const res = await inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'USD Mismatch Card', month: 6, year: 2026, account: 'BRL Mismatch Acc' } })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown bill', async () => {
    const res = await inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'Nonexistent Pay Card', month: 1, year: 2026 } })
    expect(res.statusCode).toBe(404)
  })
})
