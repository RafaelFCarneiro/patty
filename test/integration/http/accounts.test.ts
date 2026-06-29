import { describe, expect, it } from 'vitest'
import { setupHttpTest } from './setup.js'

const { inject } = setupHttpTest()

describe('GET /api/accounts', () => {
  it('lists seeded accounts', async () => {
    const res = await inject({ method: 'GET', url: '/api/accounts' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('filters by type', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Filter Checking', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Filter Savings', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'GET', url: '/api/accounts?type=savings' })
    expect(res.statusCode).toBe(200)
    const accounts = res.json() as Array<{ type: string }>
    expect(accounts.every((a) => a.type === 'savings')).toBe(true)
  })

  it('rejects invalid type (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/accounts?type=bogus' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toHaveProperty('error.code', 'validation')
  })
})

describe('POST /api/accounts', () => {
  it('creates an account (201)', async () => {
    const res = await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Test Checking', type: 'checking', currency: 'USD', initialBalance: 100 } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toHaveProperty('id')
  })

  it('rejects duplicate name (409)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/accounts', payload: {} })
    expect(res.statusCode).toBe(422)
  })

  it('rejects credit type (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Bad Credit', type: 'credit', currency: 'USD', initialBalance: 0 } })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toHaveProperty('error.code', 'validation')
  })
})

describe('PATCH /api/accounts/:name', () => {
  it('updates name and initialBalance', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Patchable', type: 'checking', currency: 'USD', initialBalance: 42 } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/Patchable', payload: 
      { newName: 'Patched', initialBalance: 500 } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Patched')
    expect(res.json().initialBalance).toBe(500)
  })

  it('allows type + currency change when no transactions', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'TypeChange', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/TypeChange', payload: 
      { type: 'savings', currency: 'BRL' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().type).toBe('savings')
    expect(res.json().currency).toBe('BRL')
  })

  it('blocks type change when transactions exist (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'TypeBlock', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Lock type', amount: 5, type: 'expense', date: '2026-06-01', account: 'TypeBlock',
        idempotencyKey: 'type-block-tx' } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/TypeBlock', payload: { type: 'savings' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.issues[0]).toContain('type cannot be changed')
  })

  it('blocks currency change when account is a card payer (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'CurBlockPayer', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: 
      { name: 'CurBlockCard', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'CurBlockPayer' } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/CurBlockPayer', payload: { currency: 'USD' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.issues[0]).toContain('credit card payment account')
  })

  it('blocks currency change when recurring rules reference account (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'CurBlockRec', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/recurring', payload: 
      { description: 'Lock cur', amount: 50, type: 'expense', period: 'monthly', startDate: '2026-07-01',
        account: 'CurBlockRec', currency: 'BRL' } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/CurBlockRec', payload: { currency: 'USD' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.issues[0]).toContain('recurring rules')
  })

  it('rejects setting type to credit (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'NoCredit', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/NoCredit', payload: { type: 'credit' } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects updating a credit account (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'CreditUpdPayer', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: 
      { name: 'CreditUpdCard', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'CreditUpdPayer' } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/Card%3A%20CreditUpdCard', payload: 
      { initialBalance: 999 } })
    expect(res.statusCode).toBe(422)
  })

  it('rejects rename to existing name (409)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'RenameA', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'RenameB', type: 'checking', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/RenameA', payload: { newName: 'RenameB' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name')
  })

  it('returns 404 for unknown account', async () => {
    const res = await inject({ method: 'PATCH', url: '/api/accounts/nonexistent-xyz-999', payload: { newName: 'X' } })
    expect(res.statusCode).toBe(404)
  })

  it('no-op returns account unchanged', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'NoopAcct', type: 'checking', currency: 'USD', initialBalance: 42 } })
    const res = await inject({ method: 'PATCH', url: '/api/accounts/NoopAcct', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('NoopAcct')
    expect(res.json().initialBalance).toBe(42)
  })
})

describe('DELETE /api/accounts/:name', () => {
  it('deletes an unused account', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'Deletable', type: 'wallet', currency: 'USD', initialBalance: 0 } })
    const res = await inject({ method: 'DELETE', url: '/api/accounts/Deletable' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('deleted', true)
  })

  it('blocked when transactions reference it (409)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'DelTxBlock', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Block del', amount: 5, type: 'expense', date: '2026-06-01', account: 'DelTxBlock',
        idempotencyKey: 'del-tx-block' } })
    const res = await inject({ method: 'DELETE', url: '/api/accounts/DelTxBlock' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('in_use')
    expect(res.json().error.references.transactions).toBeGreaterThanOrEqual(1)
  })

  it('blocked when recurring rule references it (409)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'DelRecBlock', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/recurring', payload: 
      { description: 'Block del rec', amount: 50, type: 'expense', period: 'monthly', startDate: '2026-07-01',
        account: 'DelRecBlock', currency: 'USD' } })
    const res = await inject({ method: 'DELETE', url: '/api/accounts/DelRecBlock' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.recurring).toBeGreaterThanOrEqual(1)
  })

  it('blocked when account is a card payer (409)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'DelCardBlock', type: 'checking', currency: 'USD', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: 
      { name: 'DelBlockCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'DelCardBlock' } })
    const res = await inject({ method: 'DELETE', url: '/api/accounts/DelCardBlock' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.references.cards).toBeGreaterThanOrEqual(1)
  })

  it('rejects deleting a credit account (422)', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'DelCreditPayer', type: 'checking', currency: 'BRL', initialBalance: 0 } })
    await inject({ method: 'POST', url: '/api/credit-cards', payload: 
      { name: 'DelCreditCard', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'DelCreditPayer' } })
    const res = await inject({ method: 'DELETE', url: '/api/accounts/Card%3A%20DelCreditCard' })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown account', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/accounts/nonexistent-xyz-999' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/accounts/balances', () => {
  it('returns derived balances reflecting transactions', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'BalanceAcct', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Income', amount: 500, type: 'income', date: '2026-06-01', account: 'BalanceAcct',
        idempotencyKey: 'bal-income' } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Expense', amount: 200, type: 'expense', date: '2026-06-01', account: 'BalanceAcct',
        idempotencyKey: 'bal-expense' } })
    const res = await inject({ method: 'GET', url: '/api/accounts/balances?account=BalanceAcct' })
    expect(res.statusCode).toBe(200)
    const balances = res.json() as Array<{ balance: number; income: number; expenses: number }>
    expect(balances[0].balance).toBe(1300)
    expect(balances[0].income).toBe(500)
    expect(balances[0].expenses).toBe(200)
  })

  it('pending excluded from balance, included in projectedBalance', async () => {
    await inject({ method: 'POST', url: '/api/accounts', payload: 
      { name: 'ProjAcct', type: 'checking', currency: 'USD', initialBalance: 1000 } })
    await inject({ method: 'POST', url: '/api/transactions', payload: 
      { description: 'Pending exp', amount: 300, type: 'expense', date: '2026-06-15', account: 'ProjAcct',
        status: 'pending', idempotencyKey: 'proj-pend' } })
    const noProj = await inject({ method: 'GET', url: '/api/accounts/balances?account=ProjAcct' })
    expect(noProj.json()[0].balance).toBe(1000)
    expect(noProj.json()[0].projectedBalance).toBeUndefined()
    const withProj = await inject({ method: 'GET',
      url: '/api/accounts/balances?account=ProjAcct&projectedAsOf=2026-06-30' })
    expect(withProj.json()[0].balance).toBe(1000)
    expect(withProj.json()[0].projectedBalance).toBe(700)
  })

  it('rejects invalid projectedAsOf (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/accounts/balances?projectedAsOf=bad' })
    expect(res.statusCode).toBe(422)
  })
})
