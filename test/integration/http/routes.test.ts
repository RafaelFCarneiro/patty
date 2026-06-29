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
  it('returns version and counts', async () => {
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

  it('rejects invalid type', async () => {
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
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 },
    })
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
  it('updates an account', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Patchable', type: 'checking', currency: 'USD', initialBalance: 0 },
    })
    const res = await app.inject({
      method: 'PATCH', url: '/api/accounts/Patchable',
      payload: { newName: 'Patched' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown account', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/accounts/nonexistent',
      payload: { newName: 'Whatever' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/accounts/:name', () => {
  it('deletes an unused account', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Deletable', type: 'wallet', currency: 'USD', initialBalance: 0 },
    })
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/Deletable' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown account', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/zzz-nonexistent-acc-xyz' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/accounts/balances', () => {
  it('returns balances', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts/balances' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('rejects invalid projectedAsOf', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts/balances?projectedAsOf=bad' })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Categories ───────────────────────────────────────────────

describe('GET /api/categories', () => {
  it('lists categories', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/categories' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('POST /api/categories', () => {
  it('creates a category (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/categories',
      payload: { name: 'Test Cat', kind: 'expense' },
    })
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
  it('deletes a category', async () => {
    await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Deletable Cat', kind: 'expense' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/Deletable Cat' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown category', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/categories/nonexistent' })
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
})

describe('POST /api/sub-categories', () => {
  it('creates a sub-category (201)', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Parent For Sub', kind: 'expense' } })
    const parentId = catRes.json().id
    const res = await app.inject({
      method: 'POST', url: '/api/sub-categories',
      payload: { name: 'Test Sub', parentId },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects missing parentId (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Orphan' } })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/sub-categories/:name', () => {
  it('deletes a sub-category', async () => {
    const catRes = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Parent Del Sub', kind: 'expense' } })
    const parentId = catRes.json().id
    await app.inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Del Sub', parentId } })
    const res = await app.inject({ method: 'DELETE', url: '/api/sub-categories/Del Sub' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown sub-category', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/sub-categories/nonexistent' })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Transactions ─────────────────────────────────────────────

describe('POST /api/transactions', () => {
  it('creates a transaction (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: {
        description: 'Coffee', amount: 5.50, type: 'expense',
        date: '2026-06-01', idempotencyKey: 'test-coffee-1',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('transaction')
    expect(res.json()).toHaveProperty('created', true)
  })

  it('returns 200 on idempotent duplicate', async () => {
    await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: {
        description: 'Dupe', amount: 10, type: 'expense',
        date: '2026-06-01', idempotencyKey: 'dedup-key-1',
      },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: {
        description: 'Dupe', amount: 10, type: 'expense',
        date: '2026-06-01', idempotencyKey: 'dedup-key-1',
      },
    })
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
      payload: {
        description: 'Bad', amount: 1, type: 'expense',
        date: '2026-06-01', idempotencyKey: 'bad-both',
        account: 'SomeAcc', card: 'SomeCard',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toHaveProperty('error.code', 'validation')
  })
})

describe('POST /api/transactions/bulk', () => {
  it('creates bulk transactions (201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transactions/bulk',
      payload: {
        items: [
          { description: 'Bulk 1', amount: 10, type: 'expense', date: '2026-06-01' },
          { description: 'Bulk 2', amount: 20, type: 'income', date: '2026-06-02' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toHaveProperty('items')
    expect(body.items).toHaveLength(2)
  })

  it('rejects empty items (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items: [] } })
    expect(res.statusCode).toBe(422)
  })
})

describe('PATCH /api/transactions/:id', () => {
  it('updates a transaction', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Updatable', amount: 7, type: 'expense', date: '2026-06-01', idempotencyKey: 'upd-1' },
    })
    const id = createRes.json().transaction.id
    const res = await app.inject({
      method: 'PATCH', url: `/api/transactions/${id}`,
      payload: { description: 'Updated' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown transaction', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/transactions/00000000-0000-0000-0000-000000000000',
      payload: { description: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/transactions/:id/confirm', () => {
  it('confirms a pending transaction', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Pending', amount: 5, type: 'expense', date: '2099-01-01', idempotencyKey: 'pend-1' },
    })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'POST', url: `/api/transactions/${id}/confirm` })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown transaction', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transactions/00000000-0000-0000-0000-000000000000/confirm' })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/transactions/:id', () => {
  it('dry-run by default', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Del Target', amount: 3, type: 'expense', date: '2026-06-01', idempotencyKey: 'del-1' },
    })
    const id = createRes.json().transaction.id
    const res = await app.inject({ method: 'DELETE', url: `/api/transactions/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('dryRun', true)
  })

  it('deletes with confirm=true', async () => {
    const createRes = await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Del Confirm', amount: 3, type: 'expense', date: '2026-06-01', idempotencyKey: 'del-2' },
    })
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
  it('searches transactions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transactions?from=2026-06-01&to=2026-06-30' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
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
  it('creates a credit card (201)', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Card Payer', type: 'checking', currency: 'USD', initialBalance: 0 },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Test Visa', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Card Payer' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects duplicate name (409)', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Card Payer 2', type: 'checking', currency: 'USD', initialBalance: 0 },
    })
    await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Dup Card', closingDay: 5, dueDay: 15, currency: 'USD', paymentAccount: 'Card Payer 2' },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Dup Card', closingDay: 5, dueDay: 15, currency: 'USD', paymentAccount: 'Card Payer 2' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('rejects invalid body (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/credit-cards', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /api/credit-cards/:name', () => {
  it('dry-run by default (returns card info)', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Card Payer 3', type: 'checking', currency: 'USD', initialBalance: 0 },
    })
    await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Del Card', closingDay: 1, dueDay: 10, currency: 'USD', paymentAccount: 'Card Payer 3' },
    })
    const res = await app.inject({ method: 'DELETE', url: '/api/credit-cards/Del Card' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown card', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/credit-cards/nonexistent?confirm=true' })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Bills ────────────────────────────────────────────────────

describe('GET /api/bills', () => {
  it('returns a bill for an existing card', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Bill Payer', type: 'checking', currency: 'USD', initialBalance: 1000 },
    })
    await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Bill Payer' },
    })
    await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Bill charge', amount: 50, type: 'expense', date: '2026-06-05', idempotencyKey: 'bill-chg-1', card: 'Bill Card' },
    })
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=Bill Card&month=6&year=2026' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('bill')
    expect(res.json().bill).toHaveProperty('id')
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
    const res = await app.inject({ method: 'GET', url: '/api/bills?card=Nonexistent&month=1&year=2026' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/bills/pay', () => {
  it('pays a bill', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Pay Bill Acc', type: 'checking', currency: 'USD', initialBalance: 5000 },
    })
    await app.inject({
      method: 'POST', url: '/api/credit-cards',
      payload: { name: 'Pay Bill Card', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Pay Bill Acc' },
    })
    await app.inject({
      method: 'POST', url: '/api/transactions',
      payload: { description: 'Charge for bill pay', amount: 100, type: 'expense', date: '2026-06-05', idempotencyKey: 'pay-bill-chg', card: 'Pay Bill Card' },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/bills/pay',
      payload: { card: 'Pay Bill Card', month: 6, year: 2026, account: 'Pay Bill Acc' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for unknown bill', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/bills/pay',
      payload: { card: 'Nonexistent Card', month: 1, year: 2026 },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── Transfers ────────────────────────────────────────────────

describe('POST /api/transfers', () => {
  it('creates a transfer (201)', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Transfer From', type: 'checking', currency: 'USD', initialBalance: 500 },
    })
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Transfer To', type: 'savings', currency: 'USD', initialBalance: 0 },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/transfers',
      payload: { from: 'Transfer From', to: 'Transfer To', amount: 100, date: '2026-06-01', idempotencyKey: 'xfer-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('created', true)
  })

  it('returns 200 on idempotent duplicate', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Xfer Dup From', type: 'checking', currency: 'USD', initialBalance: 500 },
    })
    await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: { name: 'Xfer Dup To', type: 'savings', currency: 'USD', initialBalance: 0 },
    })
    await app.inject({
      method: 'POST', url: '/api/transfers',
      payload: { from: 'Xfer Dup From', to: 'Xfer Dup To', amount: 50, date: '2026-06-01', idempotencyKey: 'xfer-dup-1' },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/transfers',
      payload: { from: 'Xfer Dup From', to: 'Xfer Dup To', amount: 50, date: '2026-06-01', idempotencyKey: 'xfer-dup-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('created', false)
  })

  it('rejects same account (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/transfers',
      payload: { from: 'Transfer From', to: 'Transfer From', amount: 10, date: '2026-06-01', idempotencyKey: 'xfer-same' },
    })
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
    const res = await app.inject({
      method: 'POST', url: '/api/recurring',
      payload: { description: 'Rent', amount: 1200, type: 'expense', period: 'monthly', startDate: '2026-07-01', currency: 'USD' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects invalid body (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/recurring', payload: {} })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/recurring/apply-due', () => {
  it('applies due recurring rules', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/recurring/apply-due',
      payload: { through: '2026-07-15' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('applied')
  })

  it('rejects invalid through date (422)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/recurring/apply-due',
      payload: { through: 'not-a-date' },
    })
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
    const res = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'test-tag' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects duplicate tag (409)', async () => {
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'dup-tag' } })
    const res = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'dup-tag' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
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
  })

  it('returns success with deleted:false for unknown tag', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/tags/00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', false)
  })
})

// ─── Aggregate ────────────────────────────────────────────────

describe('GET /api/aggregate', () => {
  it('returns aggregate spending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=6&year=2026' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('groupBy', 'category')
    expect(res.json()).toHaveProperty('currencies')
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
  it('returns spending summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/summary?month=6&year=2026' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('period')
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
