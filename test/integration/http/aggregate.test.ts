import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/aggregate', () => {
  it('groups by category with correct sums', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggCatAcct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg food', amount: 200, type: 'expense', date: '2025-03-15', account: 'AggCatAcct', category: 'Food', idempotencyKey: 'agg-cat-food' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg transport', amount: 50, type: 'expense', date: '2025-03-15', account: 'AggCatAcct', category: 'Transport', idempotencyKey: 'agg-cat-transport' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggCatAcct' })
    expect(res.statusCode).toBe(200)
    expect(res.json().groupBy).toBe('category')
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const foodRow = usd.rows.find((r: { label: string }) => r.label === 'Food')
    expect(foodRow.value).toBe(200)
  })

  it('excludes transfers and pending', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggExclAcct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggExclAcct2', type: 'savings', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Excl food', amount: 200, type: 'expense', date: '2025-03-15', account: 'AggExclAcct', category: 'Food', idempotencyKey: 'agg-excl-food' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Excl transport', amount: 50, type: 'expense', date: '2025-03-15', account: 'AggExclAcct', category: 'Transport', idempotencyKey: 'agg-excl-transport' } })
    await inject({ method: 'POST', url: '/api/transfers', payload: { from: 'AggExclAcct', to: 'AggExclAcct2', amount: 100, date: '2025-03-15', idempotencyKey: 'agg-excl-xfer' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Excl pending', amount: 999, type: 'expense', date: '2025-03-15', account: 'AggExclAcct', category: 'Food', status: 'pending', idempotencyKey: 'agg-excl-pending' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggExclAcct' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const totalAmount = usd.rows.reduce((sum: number, r: { value: number }) => sum + r.value, 0)
    expect(totalAmount).toBe(250)
  })

  it('groups by tag — multi-tagged transaction in both groups', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggTagAcct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-work' } })
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-travel' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Multi tag', amount: 30, type: 'expense', date: '2025-03-15', account: 'AggTagAcct', tags: ['agg-work', 'agg-travel'], idempotencyKey: 'agg-multi-tag' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=tag&month=3&year=2025&account=AggTagAcct' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-work')).toBeDefined()
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-travel')).toBeDefined()
  })

  it('limits per currency, not globally', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggLimitUSD', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggLimitBRL', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'USD exp1', amount: 100, type: 'expense', date: '2025-03-15', account: 'AggLimitUSD', category: 'Food', idempotencyKey: 'agg-limit-usd1' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'USD exp2', amount: 50, type: 'expense', date: '2025-03-15', account: 'AggLimitUSD', category: 'Transport', idempotencyKey: 'agg-limit-usd2' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'BRL exp1', amount: 10, type: 'expense', date: '2025-03-15', account: 'AggLimitBRL', category: 'Food', idempotencyKey: 'agg-limit-brl1' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'BRL exp2', amount: 5, type: 'expense', date: '2025-03-15', account: 'AggLimitBRL', category: 'Transport', idempotencyKey: 'agg-limit-brl2' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&limit=1' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const brl = res.json().currencies.find((c: { currency: string }) => c.currency === 'BRL')
    expect(usd).toBeDefined()
    expect(brl).toBeDefined()
    expect(usd.rows).toHaveLength(1)
    expect(brl.rows).toHaveLength(1)
  })

  it('groups by month over date range', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: { name: 'AggMonthAcct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Feb exp', amount: 75, type: 'expense', date: '2025-02-15', account: 'AggMonthAcct', category: 'Food', idempotencyKey: 'agg-month-feb' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Mar exp', amount: 100, type: 'expense', date: '2025-03-15', account: 'AggMonthAcct', category: 'Food', idempotencyKey: 'agg-month-mar' } })
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=month&from=2025-02-01&to=2025-04-01&account=AggMonthAcct&sort=asc' })
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
