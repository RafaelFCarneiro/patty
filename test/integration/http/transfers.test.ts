import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('POST /api/transfers', () => {
  it('creates a transfer, debits source, credits dest (201)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'TransferFrom', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'TransferTo', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'POST', url: '/api/transfers', payload: 
      { from: 'TransferFrom', to: 'TransferTo', amount: 200, date: '2026-06-01', idempotencyKey: 'xfer-1' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('created', true)
    const srcBal = await inject({ method: 'GET', url: '/api/accounts/balances?account=TransferFrom' })
    expect(srcBal.json()[0].balance).toBe(300)
    const dstBal = await inject({ method: 'GET', url: '/api/accounts/balances?account=TransferTo' })
    expect(dstBal.json()[0].balance).toBe(200)
  })

  it('transfer excluded from expense/income search', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'XferSearchSrc', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'XferSearchDst', type: 'savings', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transfers', payload: 
      { from: 'XferSearchSrc', to: 'XferSearchDst', amount: 100, date: '2026-06-01',
        idempotencyKey: 'xfer-search-1' } })
    const all = await inject({ method: 'GET',
      url: '/api/transactions?account=XferSearchSrc&from=2026-06-01&to=2026-06-30' })
    expect(all.statusCode).toBe(200)
    const allTxs = all.json() as Array<{ type: string }>
    expect(allTxs.some((t) => t.type === 'transfer')).toBe(true)
    const expenses = await inject({ method: 'GET',
      url: '/api/transactions?account=XferSearchSrc&type=expense&from=2026-06-01&to=2026-06-30' })
    expect((expenses.json() as Array<{ type: string }>).some((t) => t.type === 'transfer')).toBe(false)
  })

  it('returns 200 on idempotent duplicate', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Xfer Dup From', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Xfer Dup To', type: 'savings', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transfers', payload: 
      { from: 'Xfer Dup From', to: 'Xfer Dup To', amount: 50, date: '2026-06-01', idempotencyKey: 'xfer-dup-1' } })
    const res = await inject({ method: 'POST', url: '/api/transfers', payload: 
      { from: 'Xfer Dup From', to: 'Xfer Dup To', amount: 50, date: '2026-06-01', idempotencyKey: 'xfer-dup-1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('created', false)
  })

  it('rejects same account (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'XferSameAcct', type: 'checking', currency: 'USD', initialBalance: 500 } })
    const res = await inject({ method: 'POST', url: '/api/transfers', payload: 
      { from: 'XferSameAcct', to: 'XferSameAcct', amount: 10, date: '2026-06-01', idempotencyKey: 'xfer-same' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects credit account as source (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Xfer Credit Bank', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: 
      { name: 'Xfer Credit Card', closingDay: 28, dueDay: 5, currency: 'USD' } })
    const res = await inject({ method: 'POST', url: '/api/transfers', payload: 
      { from: 'Card: Xfer Credit Card', to: 'Xfer Credit Bank', amount: 100, idempotencyKey: 'xfer-from-credit' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects credit account as destination (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload:
      { name: 'XferCreditDstBank', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload:
      { name: 'XferCreditDstCard', closingDay: 28, dueDay: 5, currency: 'USD' } })
    const res = await inject({ method: 'POST', url: '/api/transfers', payload: {
      from: 'XferCreditDstBank', to: 'Card: XferCreditDstCard',
      amount: 100, idempotencyKey: 'xfer-to-credit',
    } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects missing fields (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/transfers', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})
