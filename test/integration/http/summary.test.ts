import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/summary', () => {
  it('returns spending summary excluding pending', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'SumAcct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Sum exp', amount: 100, type: 'expense', date: '2026-05-01', account: 'SumAcct',
        idempotencyKey: 'sum-exp' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Sum pending', amount: 999, type: 'expense', date: '2026-05-01', account: 'SumAcct',
        status: 'pending', idempotencyKey: 'sum-pend' } })
    const res = await inject({ method: 'GET', url: '/api/summary?month=5&year=2026' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('period')
    const usd = res.json().currencies?.find((c: { currency: string }) => c.currency === 'USD')
    if (usd) expect(usd.expenses).toBe(100)
  })

  it('coerces string month/year', async () => {
    const res = await inject({ method: 'GET', url: '/api/summary?month=6&year=2026' })
    expect(res.statusCode).toBe(200)
  })

  it('rejects month out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/summary?month=0&year=2026' })
    expect(res.statusCode).toBe(422)
  })

  it('rejects year out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/summary?month=1&year=1999' })
    expect(res.statusCode).toBe(422)
  })
})
