import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/tags', () => {
  it('lists tags', async () => {
    const res = await inject({ method: 'GET', url: '/api/tags' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('POST /api/tags', () => {
  it('creates a tag (201)', async () => {
    const res = await inject({ method: 'POST', url: '/api/tags', payload: { name: 'new-tag' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
    expect(res.json().name).toBe('new-tag')
  })

  it('rejects duplicate tag (409)', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'dup-tag' } })
    const res = await inject({ method: 'POST', url: '/api/tags', payload: { name: 'dup-tag' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('tags are case-sensitive', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'Case-Tag' } })
    const res = await inject({ method: 'POST', url: '/api/tags', payload: { name: 'case-tag' } })
    expect(res.statusCode).toBe(201)
  })

  it('rejects empty name (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/tags', payload: { name: '' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/tags/:id', () => {
  it('deletes a tag', async () => {
    const createRes = await inject({ method: 'POST', url: '/api/tags', payload: { name: 'del-tag' } })
    const id = createRes.json().id
    const res = await inject({ method: 'DELETE', url: `/api/tags/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('returns deleted:false for unknown tag', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/tags/00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', false)
  })
})
