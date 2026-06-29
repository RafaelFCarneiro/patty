import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/sub-categories', () => {
  it('lists sub-categories', async () => {
    const res = await inject({ method: 'GET', url: '/api/sub-categories' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('filters by parentId', async () => {
    const cat1 = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Filter Parent A', kind: 'expense' } })
    const cat2 = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Filter Parent B', kind: 'expense' } })
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Child A', parentId: cat1.json().id } })
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Child B', parentId: cat2.json().id } })
    const res = await inject({ method: 'GET', url: `/api/sub-categories?parentId=${cat1.json().id}` })
    const subs = res.json() as Array<{ parentId: string; name: string }>
    expect(subs.every((s) => s.parentId === cat1.json().id)).toBe(true)
    expect(subs.some((s) => s.name === 'Child A')).toBe(true)
  })
})

describe('POST /api/sub-categories', () => {
  it('creates a sub-category with parent info (201)', async () => {
    const catRes = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Sub Parent Info', kind: 'expense' } })
    const parentId = catRes.json().id
    const res = await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Info Sub', parentId } })
    expect(res.statusCode).toBe(201)
    expect(res.json().parentId).toBe(parentId)
    expect(res.json().parentName).toBe('Sub Parent Info')
    expect(res.json().kind).toBe('expense')
  })

  it('rejects duplicate name within same parent (409)', async () => {
    const catRes = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dup Sub Parent', kind: 'expense' } })
    const parentId = catRes.json().id
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Dup Sub', parentId } })
    const res = await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Dup Sub', parentId } })
    expect(res.statusCode).toBe(409)
  })

  it('rejects unknown parentId (404)', async () => {
    const res = await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Orphan Sub', parentId: 'cat-does-not-exist' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('unknown_category')
  })

  it('rejects missing parentId (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Orphan' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/sub-categories/:name', () => {
  it('deletes a sub-category', async () => {
    const catRes = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'DelSubParent', kind: 'expense' } })
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'DelSub', parentId: catRes.json().id } })
    const res = await inject({ method: 'DELETE', url: '/api/sub-categories/DelSub' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('blocked when a transaction references it (409)', async () => {
    const catRes = await inject({ method: 'POST', url: '/api/categories', payload: { name: 'DelSubBlockParent', kind: 'expense' } })
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'DelSubBlock', parentId: catRes.json().id } })
    await inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Sub ref', amount: 5, type: 'expense', date: '2026-06-01', subCategory: 'DelSubBlock', idempotencyKey: 'sub-ref-tx' } })
    const res = await inject({ method: 'DELETE', url: '/api/sub-categories/DelSubBlock' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('in_use')
  })

  it('returns 404 for unknown sub-category', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/sub-categories/nonexistent-sub-xyz' })
    expect(res.statusCode).toBe(404)
  })
})
