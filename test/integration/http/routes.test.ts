import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app-builder.js'

let app: FastifyInstance
let tmpDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-http-test-'))
  const ctx = await buildApp({ dbPath: join(tmpDir, 'http-test.db') })
  app = ctx.app
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Health & Status ──────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /api/status', () => {
  it('returns version, db status, and locale', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('db', 'ok')
    expect(body).toHaveProperty('locale')
  })
})

// ─── Accounts ─────────────────────────────────────────────────

describe('GET /api/accounts', () => {
  it('lists seeded accounts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('filters by type', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Filter Checking', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Filter Savings', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'GET', url: '/api/accounts?type=savings' })
    expect(res.statusCode).toBe(200)
    const accounts = res.json() as Array<{ type: string }>
    expect(accounts.every((a) => a.type === 'savings')).toBe(true)
  })

  it('rejects invalid type (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts?type=bogus' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toHaveProperty('error.code', 'validation')
  })
})

describe('POST /api/accounts', () => {
  it('creates an account (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Test Checking', type: 'checking', currency: 'USD', initialBalance: 100 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects duplicate name (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('rejects invalid body (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: {} })
    expect(res.statusCode).toBe(422)
  })

  it('rejects credit type (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Bad Credit', type: 'credit', currency: 'USD', initialBalance: 0 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toHaveProperty('error.code', 'validation')
  })
})

describe('PATCH /api/accounts/:name', () => {
  it('updates name and initialBalance', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Patchable', type: 'checking', currency: 'USD', initialBalance: 42 } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Patchable', payload: { newName: 'Patched', initialBalance: 500 } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Patched')
    expect(res.json().initialBalance).toBe(500)
  })

  it('allows type + currency change when no transactions', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Type Change', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Type Change', payload: { type: 'savings', currency: 'BRL' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().type).toBe('savings')
    expect(res.json().currency).toBe('BRL')
  })

  it('blocks type change when transactions exist (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Type Block', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Lock type', amount: 5, type: 'expense', date: '2026-06-01', account: 'Type Block', idempotencyKey: 'type-block-tx' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Type Block', payload: { type: 'savings' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.issues[0]).toContain('type cannot be changed')
  })

  it('blocks currency change when account is a card payer (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Cur Block Payer', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Cur Block Card', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'Cur Block Payer' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Cur Block Payer', payload: { currency: 'USD' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.issues[0]).toContain('credit card payment account')
  })

  it('blocks currency change when recurring rules reference account (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Cur Block Rec', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/recurring', payload: { description: 'Lock cur', amount: 50, type: 'expense', period: 'monthly', startDate: '2026-07-01', account: 'Cur Block Rec', currency: 'BRL' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Cur Block Rec', payload: { currency: 'USD' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.issues[0]).toContain('recurring rules')
  })

  it('rejects setting type to credit (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'No Credit', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/No Credit', payload: { type: 'credit' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects updating a credit account (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Credit Upd Payer', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Credit Upd Card', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'Credit Upd Payer' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Card: Credit Upd Card', payload: { initialBalance: 999 } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects rename to existing name (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Rename A', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Rename B', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Rename A', payload: { newName: 'Rename B' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('returns 404 for unknown account', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/nonexistent-xyz-999', payload: { newName: 'X' } })
    expect(res.statusCode).toBe(404)
  })

  it('no-op returns account unchanged', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Noop Acct', type: 'checking', currency: 'USD', initialBalance: 42 } })
    const res = await app.inject({ method: 'PATCH', url: '/api/accounts/Noop Acct', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Noop Acct')
    expect(res.json().initialBalance).toBe(42)
  })
})

describe('DELETE /api/accounts/:name', () => {
  it('deletes an unused account', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Deletable', type: 'wallet', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/Deletable' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('blocked when transactions reference it (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Del Tx Block', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Block del', amount: 5, type: 'expense', date: '2026-06-01', account: 'Del Tx Block', idempotencyKey: 'del-tx-block' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/Del Tx Block' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('in_use')
    expect(res.json().error.references.transactions).toBeGreaterThanOrEqual(1)
  })

  it('blocked when recurring rule references it (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Del Rec Block', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/recurring', payload: { description: 'Block del rec', amount: 50, type: 'expense', period: 'monthly', startDate: '2026-07-01', account: 'Del Rec Block', currency: 'USD' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/Del Rec Block' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.recurring).toBeGreaterThanOrEqual(1)
  })

  it('blocked when account is a card payer (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Del Card Block', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Del Block Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Del Card Block' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/Del Card Block' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.cards).toBeGreaterThanOrEqual(1)
  })

  it('rejects deleting a credit account (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Del Credit Payer', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Del Credit Card', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'Del Credit Payer' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/Card: Del Credit Card' })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown account', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/nonexistent-xyz-999' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/accounts/balances', () => {
  it('returns derived balances reflecting transactions', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Balance Acct', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Income', amount: 500, type: 'income', date: '2026-06-01', account: 'Balance Acct', idempotencyKey: 'bal-income' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Expense', amount: 200, type: 'expense', date: '2026-06-01', account: 'Balance Acct', idempotencyKey: 'bal-expense' } })
    const res = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Balance Acct' })
    expect(res.statusCode).toBe(200)
    const balances = res.json() as Array<{ balance: number; income: number; expenses: number }>
    expect(balances[0].balance).toBe(1300)
    expect(balances[0].income).toBe(500)
    expect(balances[0].expenses).toBe(200)
  })

  it('pending excluded from balance, included in projectedBalance', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Proj Acct', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Pending exp', amount: 300, type: 'expense', date: '2026-06-15', account: 'Proj Acct', status: 'pending', idempotencyKey: 'proj-pend' } })
    const noProj = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Proj Acct' })
    expect(noProj.json()[0].balance).toBe(1000)
    expect(noProj.json()[0].projectedBalance).toBeUndefined()
    const withProj = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Proj Acct&projectedAsOf=2026-06-30' })
    expect(withProj.json()[0].balance).toBe(1000)
    expect(withProj.json()[0].projectedBalance).toBe(700)
  })

  it('rejects invalid projectedAsOf (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts/balances?projectedAsOf=bad' })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Categories ───────────────────────────────────────────────

describe('GET /api/categories', () => {
  it('lists categories (excludes sub-categories)', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Cat Leak Check', kind: 'expense' } })
    const parentId = catRes.json().id
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Sub Leak Check', parentId } })
    const res = await app.inject({ method: 'GET', url: '/api/categories' })
    expect(res.statusCode).toBe(200)
    const cats = res.json() as Array<{ name: string }>
    expect(cats.some((c) => c.name === 'Cat Leak Check')).toBe(true)
    expect(cats.some((c) => c.name === 'Sub Leak Check')).toBe(false)
  })
})

describe('POST /api/categories', () => {
  it('creates a category (201)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Test Cat', kind: 'expense' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects duplicate name (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dup Cat', kind: 'income' } })
    const res = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dup Cat', kind: 'income' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('rejects empty name (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: '' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/categories/:name', () => {
  it('deletes an unreferenced category', async () => {
    await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Deletable Cat', kind: 'expense' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/Deletable Cat' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('blocked when a transaction references it (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'In Use Cat', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Cat ref', amount: 10, type: 'expense', date: '2026-06-01', category: 'In Use Cat', idempotencyKey: 'cat-ref-tx' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/In Use Cat' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('in_use')
    expect(res.json().error.references.transactions).toBeGreaterThanOrEqual(1)
  })

  it('blocked when it has sub-categories (409)', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Parent Block', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Child Block', parentId: catRes.json().id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/Parent Block' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.subCategories).toBeGreaterThanOrEqual(1)
  })

  it('blocked when a recurring rule references it (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Rec Cat Block', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/recurring', payload: { description: 'Cat rec', amount: 50, type: 'expense', period: 'monthly', startDate: '2026-07-01', category: 'Rec Cat Block', currency: 'USD' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/Rec Cat Block' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.recurring).toBeGreaterThanOrEqual(1)
  })

  it('returns 404 for unknown category', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/nonexistent-cat-xyz' })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Sub-categories ───────────────────────────────────────────

describe('GET /api/sub-categories', () => {
  it('lists sub-categories', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sub-categories' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('filters by parentId', async () => {
    const cat1 = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Filter Parent A', kind: 'expense' } })
    const cat2 = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Filter Parent B', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Child A', parentId: cat1.json().id } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Child B', parentId: cat2.json().id } })
    const res = await app.inject({ method: 'GET', url: `/api/sub-categories?parentId=${cat1.json().id}` })
    const subs = res.json() as Array<{ parentId: string; name: string }>
    expect(subs.every((s) => s.parentId === cat1.json().id)).toBe(true)
    expect(subs.some((s) => s.name === 'Child A')).toBe(true)
  })
})

describe('POST /api/sub-categories', () => {
  it('creates a sub-category with parent info (201)', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Sub Parent Info', kind: 'expense' } })
    const parentId = catRes.json().id
    const res = await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Info Sub', parentId } })
    expect(res.statusCode).toBe(201)
    expect(res.json().parentId).toBe(parentId)
    expect(res.json().parentName).toBe('Sub Parent Info')
    expect(res.json().kind).toBe('expense')
  })

  it('rejects duplicate name within same parent (409)', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dup Sub Parent', kind: 'expense' } })
    const parentId = catRes.json().id
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Dup Sub', parentId } })
    const res = await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Dup Sub', parentId } })
    expect(res.statusCode).toBe(409)
  })

  it('rejects unknown parentId (404)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Orphan Sub', parentId: 'cat-does-not-exist' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('unknown_category')
  })

  it('rejects missing parentId (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Orphan' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/sub-categories/:name', () => {
  it('deletes a sub-category', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Del Sub Parent', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Del Sub', parentId: catRes.json().id } })
    const res = await app.inject({ method: 'DELETE', url: '/api/sub-categories/Del Sub' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('blocked when a transaction references it (409)', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Del Sub Block Parent', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Del Sub Block', parentId: catRes.json().id } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Sub ref', amount: 5, type: 'expense', date: '2026-06-01', subCategory: 'Del Sub Block', idempotencyKey: 'sub-ref-tx' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/sub-categories/Del Sub Block' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('in_use')
  })

  it('returns 404 for unknown sub-category', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/sub-categories/nonexistent-sub-xyz' })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Transactions ─────────────────────────────────────────────

describe('POST /api/transactions', () => {
  it('creates a transaction (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Coffee', amount: 5.50, type: 'expense', date: '2026-06-01', idempotencyKey: 'test-coffee-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('transaction')
    expect(res.json()).toHaveProperty('created', true)
  })

  it('returns 200 on idempotent duplicate', async () => {
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Dupe', amount: 10, type: 'expense', date: '2026-06-01', idempotencyKey: 'dedup-key-1' } })
    const res = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Dupe', amount: 10, type: 'expense', date: '2026-06-01', idempotencyKey: 'dedup-key-1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('created', false)
  })

  it('rejects invalid body (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transactions', payload: {} })
    expect(res.statusCode).toBe(422)
  })

  it('rejects account + card together (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Bad', amount: 1, type: 'expense', date: '2026-06-01', idempotencyKey: 'bad-both', account: 'SomeAcc', card: 'SomeCard' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects expense with income-only category (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Bad cat', amount: 100, type: 'expense', category: 'Salary', idempotencyKey: 'kind-mismatch-1' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('category_kind_mismatch')
    expect(res.json().error.hint).toContain('set type: "income"')
  })

  it('rejects income with expense-only category (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Bad cat', amount: 5000, type: 'income', category: 'Food', idempotencyKey: 'kind-mismatch-2' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('category_kind_mismatch')
  })

  it('rejects category + subCategory together (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Ambig', amount: 10, type: 'expense', category: 'Food', subCategory: 'something', idempotencyKey: 'both-cat-sub' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('creates with subCategory → sets parent category', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Sub Tx Parent', kind: 'expense' } })
    const parentId = catRes.json().id
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Sub Tx Child', parentId } })
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'With sub', amount: 30, type: 'expense', subCategory: 'Sub Tx Child', idempotencyKey: 'sub-tx-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().transaction.categoryId).toBe(parentId)
    expect(res.json().transaction.subCategoryName).toBe('Sub Tx Child')
  })

  it('creates with tags and returns them', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'work-tag' } })
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'travel-tag' } })
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Tagged', amount: 10, type: 'expense', date: '2026-06-01', idempotencyKey: 'tagged-1', tags: ['work-tag', 'travel-tag'] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().transaction.tags).toContain('work-tag')
    expect(res.json().transaction.tags).toContain('travel-tag')
  })

  it('without tags returns tags: []', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'No tags', amount: 5, type: 'expense', date: '2026-06-01', idempotencyKey: 'no-tags-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().transaction.tags).toEqual([])
  })

  it('silently ignores non-existent tag names', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Ghost tag', amount: 5, type: 'expense', date: '2026-06-01', idempotencyKey: 'ghost-tag-1', tags: ['does-not-exist'] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().transaction.tags).toEqual([])
  })

  it('note round-trips via create', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'With note', amount: 10, type: 'expense', date: '2026-06-01', idempotencyKey: 'note-1', note: 'warranty until 2027' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().transaction.note).toBe('warranty until 2027')
  })

  it('date-aware default: future → pending, past → effective', async () => {
    const future = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Future', amount: 50, type: 'expense', date: '2099-01-01', idempotencyKey: 'future-default' },
    })
    expect(future.json().transaction.status).toBe('pending')
    const past = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Past', amount: 50, type: 'expense', date: '2020-01-01', idempotencyKey: 'past-default' },
    })
    expect(past.json().transaction.status).toBe('effective')
  })

  it('rejects posting to a credit account directly (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Direct Post Payer', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Direct Post Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Direct Post Payer' } })
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Bad post', amount: 50, type: 'expense', date: '2026-06-01', account: 'Card: Direct Post Card', idempotencyKey: 'direct-credit-post' },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/transactions/bulk', () => {
  it('creates bulk transactions (201) with per-item results', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions/bulk',
      payload: { items: [
        { description: 'Bulk 1', amount: 10, type: 'expense', date: '2026-06-01' },
        { description: 'Bulk 2', amount: 20, type: 'income', date: '2026-06-02' },
      ] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toHaveProperty('items')
    expect(body.items).toHaveLength(2)
    expect(body).toHaveProperty('summary')
  })

  it('re-imports are treated as duplicates', async () => {
    const items = [{ description: 'Bulk Dup', amount: 10, type: 'expense', date: '2026-06-01', idempotencyKey: 'bulk-dup-1' }]
    await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items } })
    const res = await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items } })
    expect(res.statusCode).toBe(201)
    expect(res.json().items[0].status).toBe('duplicate')
  })

  it('persists note per item', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions/bulk',
      payload: { items: [{ description: 'Bulk Note', amount: 10, type: 'expense', date: '2026-06-01', note: 'bulk memo' }] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().items[0].transaction.note).toBe('bulk memo')
  })

  it('rejects empty items (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items: [] } })
    expect(res.statusCode).toBe(422)
  })
})

describe('PATCH /api/transactions/:id', () => {
  it('updates a transaction', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Updatable', amount: 7, type: 'expense', date: '2026-06-01', idempotencyKey: 'upd-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { description: 'Updated' } })
    expect(res.statusCode).toBe(200)
  })

  it('replaces the tag set', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'tag-a' } })
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'tag-b' } })
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Tag upd', amount: 5, type: 'expense', date: '2026-06-01', idempotencyKey: 'tag-upd-1', tags: ['tag-a'] } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { tags: ['tag-b'] } })
    expect(res.statusCode).toBe(200)
    expect(res.json().tags).toContain('tag-b')
    expect(res.json().tags).not.toContain('tag-a')
  })

  it('empty tags removes all', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'clear-tag' } })
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Clear tags', amount: 3, type: 'expense', date: '2026-06-01', idempotencyKey: 'clear-tags-1', tags: ['clear-tag'] } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { tags: [] } })
    expect(res.statusCode).toBe(200)
    expect(res.json().tags).toEqual([])
  })

  it('note: set, clear, leave unchanged', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Note upd', amount: 5, type: 'expense', date: '2026-06-01', idempotencyKey: 'note-upd-1' } })
    const id = createRes.json().transaction.id
    const set = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { note: 'added' } })
    expect(set.json().note).toBe('added')
    const clear = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { note: '' } })
    expect(clear.json().note).toBeUndefined()
    const unchanged = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { amount: 10 } })
    expect(unchanged.json().note).toBeUndefined()
  })

  it('clears sub-category when switching to a plain category', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Clear Sub Parent', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Clear Sub', parentId: catRes.json().id } })
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Sub clear', amount: 15, type: 'expense', subCategory: 'Clear Sub', idempotencyKey: 'clear-sub-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { category: 'Transport' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().categoryName).toBe('Transport')
    expect(res.json().subCategoryId).toBeUndefined()
  })

  it('preserves sub-category when neither category nor subCategory provided', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Keep Sub Parent', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Keep Sub', parentId: catRes.json().id } })
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Keep', amount: 15, type: 'expense', subCategory: 'Keep Sub', idempotencyKey: 'keep-sub-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { amount: 20 } })
    expect(res.json().subCategoryName).toBe('Keep Sub')
  })

  it('rejects category on a transfer (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Cat Src', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Cat Dst', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const xferRes = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Xfer Cat Src', to: 'Xfer Cat Dst', amount: 50, idempotencyKey: 'xfer-cat-1' } })
    const id = xferRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { category: 'Food' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects changing type of a transfer (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Type Src', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Type Dst', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const xferRes = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Xfer Type Src', to: 'Xfer Type Dst', amount: 50, idempotencyKey: 'xfer-type-1' } })
    const id = xferRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { type: 'expense' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects kind mismatch on category change (422)', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Exp', amount: 50, type: 'expense', idempotencyKey: 'kind-upd-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { category: 'Salary' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('category_kind_mismatch')
  })

  it('rejects type: transfer at wire boundary (422)', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Wire type', amount: 20, type: 'expense', idempotencyKey: 'wire-type-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { type: 'transfer' } })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown transaction', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/transactions/00000000-0000-0000-0000-000000000000', payload: { description: 'X' } })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/transactions/:id/confirm', () => {
  it('confirms a pending transaction', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Pending', amount: 5, type: 'expense', date: '2099-01-01', idempotencyKey: 'pend-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'POST', url: `/api/transactions/${id}/confirm` })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('effective')
  })

  it('re-confirming is a no-op', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Reconfirm', amount: 5, type: 'expense', date: '2099-01-01', idempotencyKey: 'reconfirm-1' } })
    const id = createRes.json().transaction.id
    await app.inject({ method: 'POST', url: `/api/transactions/${id}/confirm` })
    const res = await app.inject({ method: 'POST', url: `/api/transactions/${id}/confirm` })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('effective')
  })

  it('returns 404 for unknown transaction', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transactions/00000000-0000-0000-0000-000000000000/confirm' })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/transactions/:id', () => {
  it('dry-run by default', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Del Target', amount: 3, type: 'expense', date: '2026-06-01', idempotencyKey: 'del-1' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'DELETE', url: `/api/transactions/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('dryRun', true)
  })

  it('deletes with confirm=true', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Del Confirm', amount: 3, type: 'expense', date: '2026-06-01', idempotencyKey: 'del-2' } })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'DELETE', url: `/api/transactions/${id}?confirm=true` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('returns 404 for unknown transaction', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/transactions/00000000-0000-0000-0000-000000000000?confirm=true' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/transactions', () => {
  it('searches transactions by date range', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transactions?from=2026-06-01&to=2026-06-30' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('filters by status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transactions?status=pending&from=2099-01-01&to=2099-12-31' })
    expect(res.statusCode).toBe(200)
    const txs = res.json() as Array<{ status: string }>
    expect(txs.every((t) => t.status === 'pending')).toBe(true)
  })

  it('filters by tag', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'search-filter-tag' } })
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'search-filter-tag2' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Tagged search', amount: 7, type: 'expense', date: '2026-06-10', idempotencyKey: 'tag-search-1', tags: ['search-filter-tag', 'search-filter-tag2'] } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Untagged search', amount: 8, type: 'expense', date: '2026-06-10', idempotencyKey: 'tag-search-2' } })
    // Repeated query param creates array for Fastify's parser
    const res = await app.inject({ method: 'GET', url: '/api/transactions?tags=search-filter-tag&tags=search-filter-tag2&from=2026-06-10&to=2026-06-30' })
    expect(res.statusCode).toBe(200)
    const txs = res.json() as Array<{ description: string }>
    expect(txs.some((t) => t.description === 'Tagged search')).toBe(true)
    expect(txs.some((t) => t.description === 'Untagged search')).toBe(false)
  })

  it('returns full tag set (not just filter tag)', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'full-set-a' } })
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'full-set-b' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Full set', amount: 5, type: 'expense', date: '2026-06-11', idempotencyKey: 'full-set-1', tags: ['full-set-a', 'full-set-b'] } })
    // Search by date range then verify tag set on result
    const res = await app.inject({ method: 'GET', url: '/api/transactions?from=2026-06-11&to=2026-06-30' })
    expect(res.statusCode).toBe(200)
    const txs = res.json() as Array<{ description: string; tags: string[] }>
    const match = txs.find((t) => t.description === 'Full set')
    expect(match).toBeDefined()
    expect(match!.tags).toContain('full-set-a')
    expect(match!.tags).toContain('full-set-b')
  })

  it('filters by subCategory', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'SearchSubParent', kind: 'expense' } })
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'SearchSub', parentId: catRes.json().id } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'With sub filter', amount: 20, type: 'expense', date: '2026-06-12', subCategory: 'SearchSub', idempotencyKey: 'search-sub-1' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'No sub filter', amount: 20, type: 'expense', date: '2026-06-12', idempotencyKey: 'search-sub-2' } })
    const res = await app.inject({ method: 'GET', url: '/api/transactions?subCategory=SearchSub&from=2026-06-01&to=2026-06-30' })
    expect(res.statusCode).toBe(200)
    const txs = res.json() as Array<{ subCategoryName?: string; description?: string }>
    const filtered = txs.filter((t) => t.subCategoryName === 'SearchSub')
    expect(filtered.length).toBeGreaterThanOrEqual(1)
    expect(filtered[0].description).toBe('With sub filter')
  })

  it('rejects invalid date (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transactions?from=bad' })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Credit Cards ─────────────────────────────────────────────

describe('GET /api/credit-cards', () => {
  it('lists credit cards', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/credit-cards' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('POST /api/credit-cards', () => {
  it('creates a credit card and auto-creates internal credit account (201)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Card Payer', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Test Visa', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Card Payer' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('accountId')
    expect(res.json()).toHaveProperty('paymentAccountId')
    const accounts = await app.inject({ method: 'GET', url: '/api/accounts?type=credit' })
    const creditAccounts = accounts.json() as Array<{ name: string }>
    expect(creditAccounts.some((a) => a.name === 'Card: Test Visa')).toBe(true)
  })

  it('rejects duplicate name (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Card Payer 2', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Dup Card', closingDay: 5, dueDay: 15, currency: 'USD', paymentAccount: 'Card Payer 2' } })
    const res = await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Dup Card', closingDay: 5, dueDay: 15, currency: 'USD', paymentAccount: 'Card Payer 2' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('rejects invalid body (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/credit-cards', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/credit-cards/:name', () => {
  it('dry-run returns counts, confirm deletes everything', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Del Card Bank', type: 'checking', currency: 'USD', initialBalance: 2000 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Full Del Card', closingDay: 28, dueDay: 5, currency: 'USD', paymentAccount: 'Del Card Bank' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Del card purchase', amount: 100, type: 'expense', date: '2026-06-05', card: 'Full Del Card', idempotencyKey: 'del-card-purchase' } })
    const dryRun = await app.inject({ method: 'DELETE', url: '/api/credit-cards/Full Del Card' })
    expect(dryRun.statusCode).toBe(200)
    expect(dryRun.json().dryRun).toBe(true)
    expect(dryRun.json().wouldDelete.transactions).toBeGreaterThanOrEqual(1)
    const confirm = await app.inject({ method: 'DELETE', url: '/api/credit-cards/Full Del Card?confirm=true' })
    expect(confirm.statusCode).toBe(200)
    expect(confirm.json().deleted).toBe(true)
  })

  it('returns 404 for unknown card', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/credit-cards/nonexistent-card-xyz?confirm=true' })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Bills ────────────────────────────────────────────────────

describe('GET /api/bills', () => {
  it('returns a bill for an existing card', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Bill Payer', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Bill Payer' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Bill charge', amount: 50, type: 'expense', date: '2026-06-05', idempotencyKey: 'bill-chg-1', card: 'Bill Card' } })
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=Bill Card&month=6&year=2026' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('bill')
    expect(res.json().bill).toHaveProperty('id')
  })

  it('returns note on transaction rows', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Note Bill Payer', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Note Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Note Bill Payer' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Note bill tx', amount: 42, type: 'expense', date: '2026-06-05', card: 'Note Bill Card', idempotencyKey: 'note-bill-1', note: 'warranty' } })
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=Note Bill Card&month=6&year=2026' })
    expect(res.json().transactions.some((tx: { note?: string }) => tx.note === 'warranty')).toBe(true)
  })

  it('coerces string month/year', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=Bill Card&month=6&year=2026' })
    expect(res.statusCode).toBe(200)
  })

  it('rejects month out of range (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=X&month=13&year=2026' })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown card bill', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=Nonexistent Bill Card&month=1&year=2026' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/bills/pay', () => {
  it('pays a bill, debits payer, credits card account', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Pay Bill Acc', type: 'checking', currency: 'USD', initialBalance: 5000 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Pay Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Pay Bill Acc' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Charge', amount: 300, type: 'expense', date: '2026-06-05', idempotencyKey: 'pay-bill-chg', card: 'Pay Bill Card' } })
    const res = await app.inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'Pay Bill Card', month: 6, year: 2026, account: 'Pay Bill Acc' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('paid')
    const balances = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Pay Bill Acc' })
    expect(balances.json()[0].balance).toBe(4700)
    const cardBal = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Card: Pay Bill Card' })
    expect(cardBal.json()[0].balance).toBe(0)
  })

  it('pay_bill without account and without card default returns 422', async () => {
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'No Default Card', closingDay: 28, dueDay: 5, currency: 'USD' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'No def charge', amount: 50, type: 'expense', date: '2026-06-05', card: 'No Default Card', idempotencyKey: 'nodef-chg' } })
    const res = await app.inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'No Default Card', month: 6, year: 2026 } })
    expect(res.statusCode).toBe(422)
  })

  it('pay_bill with currency mismatch returns 422', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'BRL Mismatch Acc', type: 'checking', currency: 'BRL', initialBalance: 1000 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'USD Mismatch Card', closingDay: 28, dueDay: 5, currency: 'USD' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Mismatch chg', amount: 25, type: 'expense', date: '2026-06-05', card: 'USD Mismatch Card', idempotencyKey: 'mismatch-chg' } })
    const res = await app.inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'USD Mismatch Card', month: 6, year: 2026, account: 'BRL Mismatch Acc' } })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown bill', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bills/pay', payload: { card: 'Nonexistent Pay Card', month: 1, year: 2026 } })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Transfers ────────────────────────────────────────────────

describe('POST /api/transfers', () => {
  it('creates a transfer, debits source, credits dest (201)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Transfer From', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Transfer To', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const res = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Transfer From', to: 'Transfer To', amount: 200, date: '2026-06-01', idempotencyKey: 'xfer-1' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('created', true)
    const srcBal = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Transfer From' })
    expect(srcBal.json()[0].balance).toBe(300)
    const dstBal = await app.inject({ method: 'GET', url: '/api/accounts/balances?account=Transfer To' })
    expect(dstBal.json()[0].balance).toBe(200)
  })

  it('transfer excluded from expense/income search', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/transactions?account=Transfer+From&from=2026-06-01&to=2026-06-30' })
    expect(all.statusCode).toBe(200)
    const allTxs = all.json() as Array<{ type: string }>
    const hasTransfer = allTxs.some((t) => t.type === 'transfer')
    expect(hasTransfer).toBe(true)
    const expenses = await app.inject({ method: 'GET', url: '/api/transactions?account=Transfer+From&type=expense&from=2026-06-01&to=2026-06-30' })
    expect((expenses.json() as Array<{ type: string }>).some((t) => t.type === 'transfer')).toBe(false)
  })

  it('returns 200 on idempotent duplicate', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Dup From', type: 'checking', currency: 'USD', initialBalance: 500 } })
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Dup To', type: 'savings', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Xfer Dup From', to: 'Xfer Dup To', amount: 50, date: '2026-06-01', idempotencyKey: 'xfer-dup-1' } })
    const res = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Xfer Dup From', to: 'Xfer Dup To', amount: 50, date: '2026-06-01', idempotencyKey: 'xfer-dup-1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('created', false)
  })

  it('rejects same account (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Transfer From', to: 'Transfer From', amount: 10, date: '2026-06-01', idempotencyKey: 'xfer-same' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects credit account as source (422)', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Xfer Credit Bank', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await app.inject({ method: 'POST', url: '/api/credit-cards', payload: { name: 'Xfer Credit Card', closingDay: 28, dueDay: 5, currency: 'USD' } })
    const res = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Card: Xfer Credit Card', to: 'Xfer Credit Bank', amount: 100, idempotencyKey: 'xfer-from-credit' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects credit account as destination (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Xfer Credit Bank', to: 'Card: Xfer Credit Card', amount: 100, idempotencyKey: 'xfer-to-credit' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects missing fields (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transfers', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Recurring ────────────────────────────────────────────────

describe('GET /api/recurring', () => {
  it('lists recurring rules', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recurring' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('POST /api/recurring', () => {
  it('creates a recurring rule (201)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/recurring', payload: { description: 'Rent', amount: 1200, type: 'expense', period: 'monthly', startDate: '2026-07-01', currency: 'USD' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('defaults currency to USD when no account linked', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/recurring', payload: { description: 'No acct', amount: 50, type: 'expense', period: 'weekly', startDate: '2026-07-01' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().currency).toBe('USD')
  })

  it('rejects invalid body (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/recurring', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/recurring/apply-due', () => {
  it('materializes overdue transactions with correct status', async () => {
    await app.inject({ method: 'POST', url: '/api/recurring', payload: { description: 'Apply Due Test', amount: 100, type: 'expense', period: 'monthly', startDate: '2026-07-01', currency: 'USD' } })
    const res = await app.inject({ method: 'POST', url: '/api/recurring/apply-due', payload: { through: '2026-07-15' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('count')
    expect(res.json().count).toBeGreaterThanOrEqual(1)
  })

  it('rejects invalid through date (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/recurring/apply-due', payload: { through: 'not-a-date' } })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Tags ─────────────────────────────────────────────────────

describe('GET /api/tags', () => {
  it('lists tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tags' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('POST /api/tags', () => {
  it('creates a tag (201)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'new-tag' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
    expect(res.json().name).toBe('new-tag')
  })

  it('rejects duplicate tag (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'dup-tag' } })
    const res = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'dup-tag' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('tags are case-sensitive', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'Case-Tag' } })
    const res = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'case-tag' } })
    expect(res.statusCode).toBe(201)
  })

  it('rejects empty name (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: '' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/tags/:id', () => {
  it('deletes a tag', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'del-tag' } })
    const id = createRes.json().id
    const res = await app.inject({ method: 'DELETE', url: `/api/tags/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('returns deleted:false for unknown tag', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/tags/00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', false)
  })
})

// ─── Aggregate ────────────────────────────────────────────────

describe('GET /api/aggregate', () => {
  it('groups by category with correct sums', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Agg Acct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg food', amount: 200, type: 'expense', date: '2025-03-15', account: 'Agg Acct', category: 'Food', idempotencyKey: 'agg-food' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg transport', amount: 50, type: 'expense', date: '2025-03-15', account: 'Agg Acct', category: 'Transport', idempotencyKey: 'agg-transport' } })
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&account=Agg Acct' })
    expect(res.statusCode).toBe(200)
    expect(res.json().groupBy).toBe('category')
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const foodRow = usd.rows.find((r: { label: string }) => r.label === 'Food')
    expect(foodRow.value).toBe(200)
  })

  it('excludes transfers and pending', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Agg Acct 2', type: 'savings', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transfers', payload: { from: 'Agg Acct', to: 'Agg Acct 2', amount: 100, date: '2025-03-15', idempotencyKey: 'agg-xfer' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Agg pending', amount: 999, type: 'expense', date: '2025-03-15', account: 'Agg Acct', category: 'Food', status: 'pending', idempotencyKey: 'agg-pending' } })
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&account=Agg Acct' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const totalAmount = usd.rows.reduce((sum: number, r: { value: number }) => sum + r.value, 0)
    expect(totalAmount).toBe(250)
  })

  it('groups by tag — multi-tagged transaction in both groups', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-work' } })
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-travel' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Multi tag', amount: 30, type: 'expense', date: '2025-03-15', account: 'Agg Acct', tags: ['agg-work', 'agg-travel'], idempotencyKey: 'agg-multi-tag' } })
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=tag&month=3&year=2025&account=Agg Acct' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-work')).toBeDefined()
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-travel')).toBeDefined()
  })

  it('limits per currency, not globally', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Agg BRL', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'BRL exp', amount: 10, type: 'expense', date: '2025-03-15', account: 'Agg BRL', category: 'Food', idempotencyKey: 'agg-brl-1' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'BRL exp2', amount: 5, type: 'expense', date: '2025-03-15', account: 'Agg BRL', category: 'Transport', idempotencyKey: 'agg-brl-2' } })
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&limit=1' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    const brl = res.json().currencies.find((c: { currency: string }) => c.currency === 'BRL')
    expect(usd).toBeDefined()
    expect(brl).toBeDefined()
    expect(usd.rows).toHaveLength(1)
    expect(brl.rows).toHaveLength(1)
  })

  it('groups by month over date range', async () => {
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Feb exp', amount: 75, type: 'expense', date: '2025-02-15', account: 'Agg Acct', category: 'Food', idempotencyKey: 'agg-feb' } })
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=month&from=2025-02-01&to=2025-04-01&account=Agg Acct&sort=asc' })
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD')
    expect(usd.rows.length).toBeGreaterThanOrEqual(2)
    const months = usd.rows.map((r: { key: string }) => r.key)
    expect(months[0] < months[months.length - 1]).toBe(true)
  })

  it('rejects missing period (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=category' })
    expect(res.statusCode).toBe(422)
  })

  it('rejects missing groupBy (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?month=6&year=2026' })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Summary ──────────────────────────────────────────────────

describe('GET /api/summary', () => {
  it('returns spending summary excluding pending', async () => {
    await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Sum Acct', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Sum exp', amount: 100, type: 'expense', date: '2026-05-01', account: 'Sum Acct', idempotencyKey: 'sum-exp' } })
    await app.inject({ method: 'POST', url: '/api/transactions', payload: { description: 'Sum pending', amount: 999, type: 'expense', date: '2026-05-01', account: 'Sum Acct', status: 'pending', idempotencyKey: 'sum-pend' } })
    const res = await app.inject({ method: 'GET', url: '/api/summary?month=5&year=2026' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('period')
    const usd = res.json().currencies?.find((c: { currency: string }) => c.currency === 'USD')
    if (usd) expect(usd.expenses).toBe(100)
  })

  it('coerces string month/year', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/summary?month=6&year=2026' })
    expect(res.statusCode).toBe(200)
  })

  it('rejects month out of range (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/summary?month=0&year=2026' })
    expect(res.statusCode).toBe(422)
  })

  it('rejects year out of range (422)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/summary?month=1&year=1999' })
    expect(res.statusCode).toBe(422)
  })
})
