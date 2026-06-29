import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/categories', () => {
  it('lists categories (excludes sub-categories)', async () => {
    const catRes = await inject({ method: 'POST', url: '/api/categories', payload: 
      { name: 'Cat Leak Check', kind: 'expense' } })
    const parentId = catRes.json().id
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Sub Leak Check', parentId } })
    const res = await inject({ method: 'GET', url: '/api/categories' })
    expect(res.statusCode).toBe(200)
    const cats = res.json() as Array<{ name: string }>
    expect(cats.some((c) => c.name === 'Cat Leak Check')).toBe(true)
    expect(cats.some((c) => c.name === 'Sub Leak Check')).toBe(false)
  })
})

describe('POST /api/categories', () => {
  it('creates a category (201)', async () => {
    const res = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Test Cat', kind: 'expense' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects duplicate name (409)', async () => {
    await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dup Cat', kind: 'income' } })
    const res = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dup Cat', kind: 'income' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('rejects empty name (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/categories', payload: { name: '' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/categories/:name', () => {
  it('deletes an unreferenced category', async () => {
    await inject({ method: 'POST', url: '/api/categories', payload: { name: 'DeletableCat', kind: 'expense' } })
    const res = await inject({ method: 'DELETE', url: '/api/categories/DeletableCat' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('blocked when a transaction references it (409)', async () => {
    await inject({ method: 'POST', url: '/api/categories', payload: { name: 'InUseCat', kind: 'expense' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Cat ref', amount: 10, type: 'expense', date: '2026-06-01', category: 'InUseCat',
        idempotencyKey: 'cat-ref-tx' } })
    const res = await inject({ method: 'DELETE', url: '/api/categories/InUseCat' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('in_use')
    expect(res.json().error.references.transactions).toBeGreaterThanOrEqual(1)
  })

  it('blocked when it has sub-categories (409)', async () => {
    const catRes = await inject({ method: 'POST', url: '/api/categories', payload: 
      { name: 'ParentBlock', kind: 'expense' } })
    await inject({ method: 'POST', url: '/api/sub-categories', payload: 
      { name: 'ChildBlock', parentId: catRes.json().id } })
    const res = await inject({ method: 'DELETE', url: '/api/categories/ParentBlock' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.subCategories).toBeGreaterThanOrEqual(1)
  })

  it('blocked when a recurring rule references it (409)', async () => {
    await inject({ method: 'POST', url: '/api/categories', payload: { name: 'RecCatBlock', kind: 'expense' } })
    await inject({ method: 'POST', url: '/api/recurring', payload: 
      { description: 'Cat rec', amount: 50, type: 'expense', period: 'monthly', startDate: '2026-07-01',
        category: 'RecCatBlock', currency: 'USD' } })
    const res = await inject({ method: 'DELETE', url: '/api/categories/RecCatBlock' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.recurring).toBeGreaterThanOrEqual(1)
  })

  it('returns 404 for unknown category', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/categories/nonexistent-cat-xyz' })
    expect(res.statusCode).toBe(404)
  })
})
