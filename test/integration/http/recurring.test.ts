import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/recurring', () => {
  it('lists recurring rules', async () => {
    const res = await inject({ method: 'GET', url: '/api/recurring' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('POST /api/recurring', () => {
  it('creates a recurring rule (201)', async () => {
    const res = await inject({ method: 'POST', url: '/api/recurring', payload: 
      { description: 'Rent', amount: 1200, type: 'expense', period: 'monthly', startDate: '2026-07-01',
        currency: 'USD' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('defaults currency to USD when no account linked', async () => {
    const res = await inject({ method: 'POST', url: '/api/recurring', payload: 
      { description: 'No acct', amount: 50, type: 'expense', period: 'weekly', startDate: '2026-07-01' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().currency).toBe('USD')
  })

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/recurring', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/recurring/apply-due', () => {
  it('materializes overdue transactions with correct status', async () => {
    await inject({ method: 'POST', url: '/api/recurring', payload: 
      { description: 'Apply Due Test', amount: 100, type: 'expense', period: 'monthly', startDate: '2026-07-01',
        currency: 'USD' } })
    const res = await inject({ method: 'POST', url: '/api/recurring/apply-due', payload: { through: '2026-07-15' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('count')
    expect(res.json().count).toBeGreaterThanOrEqual(1)
  })

  it('rejects invalid through date (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/recurring/apply-due', payload: { through: 'not-a-date' } })
    expect(res.statusCode).toBe(422)
  })
})
