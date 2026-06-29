import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/aggregate', () => {
  it('groups by category with correct sums', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggAcct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg food', amount: 200, type: 'expense', date: '2025-03-15', account: 'AggAcct', category: 'Food', idempotencyKey: 'agg-food' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg transport', amount: 50, type: 'expense', date: '2025-03-15', account: 'AggAcct', category: 'Transport', idempotencyKey: 'agg-transport' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggAcct' })
    expect(res.statusCode).toBe(200)
    expect(res.json().groupBy).toBe('category')
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const foodRow = usd.rows.find((r: { label: string }) => r.label === 'Food')
    expect(foodRow.value).toBe(200)
  })

  it('excludes transfers and pending', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggAcct2', type: 'savings', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transfers', payload: { from: 'AggAcct', to: 'AggAcct2', amount: 100, date: '2025-03-15', idempotencyKey: 'agg-xfer' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg pending', amount: 999, type: 'expense', date: '2025-03-15', account: 'AggAcct', category: 'Food', status: 'pending', idempotencyKey: 'agg-pending' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggAcct' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const totalAmount = usd.rows.reduce((sum: number, r: { value: number }) => sum + r.value, 0)
    expect(totalAmount).toBe(250)
  })

  it('groups by tag — multi-tagged transaction in both groups', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-work' } })
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-travel' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Multi tag', amount: 30, type: 'expense', date: '2025-03-15', account: 'AggAcct', tags: ['agg-work', 'agg-travel'], idempotencyKey: 'agg-multi-tag' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=tag&month=3&year=2025&account=AggAcct' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-work')).toBeDefined()
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-travel')).toBeDefined()
  })

  it('limits per currency, not globally', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggBRL', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'BRL exp', amount: 10, type: 'expense', date: '2025-03-15', account: 'AggBRL', category: 'Food', idempotencyKey: 'agg-brl-1' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'BRL exp2', amount: 5, type: 'expense', date: '2025-03-15', account: 'AggBRL', category: 'Transport', idempotencyKey: 'agg-brl-2' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&limit=1' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const brl = res.json().currencies.find((c: { currency: string }) => c.currency === 'BRL')
    expect(usd).toBeDefined()
    expect(brl).toBeDefined()
    expect(usd.rows).toHaveLength(1)
    expect(brl.rows).toHaveLength(1)
  })

  it('groups by month over date range', async () => {
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Feb exp', amount: 75, type: 'expense', date: '2025-02-15', account: 'AggAcct', category: 'Food', idempotencyKey: 'agg-feb' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=month&from=2025-02-01&to=2025-04-01&account=AggAcct&sort=asc' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    expect(usd.rows.length).toBeGreaterThanOrEqual(2)
    const months = usd.rows.map((r: { key: string }) => r.key)
    expect(months[0] < months[months.length - 1]).toBe(true)
  })

  it('rejects missing period (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category' })
    expect(res.statusCode).toBe(422)
  })

  it('rejects missing groupBy (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/aggregate?month=6&year=2026' })
    expect(res.statusCode).toBe(422)
  })
})
