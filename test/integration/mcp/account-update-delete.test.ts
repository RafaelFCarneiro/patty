import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, callToolError, deleteTransactions, makeClient } from './helpers.js'

type Account = { id: string; name: string; type: string; currency: string; initialBalance: number }
type ErrorPayload<T = unknown> = { error: T }
type InUseError = { code: string; entity: string; name: string; references: { transactions: number; recurring: number; cards: number } }
type ValidationError = { code: string; issues: string[] }

describe('MCP integration > account update + delete', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport
  const stamp = Date.now()
  const createdTxIds: string[] = []

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)
  })

  afterAll(async () => {
    await deleteTransactions(createdTxIds)
    await transport.close()
  })

  // --- delete_account ---

  it('delete_account succeeds for an unreferenced account', async () => {
    const name = `del-acct-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    const result = (await callTool(client, { name: 'delete_account', args: { name } })) as { deleted: boolean }
    expect(result.deleted).toBe(true)

    const all = (await callTool(client, { name: 'list_accounts' })) as Account[]
    expect(all.some((a) => a.name === name)).toBe(false)
  })

  it('delete_account blocked when a transaction references it', async () => {
    const name = `del-tx-acct-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    const txResult = (await callTool(client, {
      name: 'create_transaction',
      args: {
        description: `tx-for-del-${stamp}`,
        amount: 10,
        type: 'expense',
        date: '2026-01-15',
        account: name,
        idempotencyKey: `del-acct-tx-${stamp}`,
      },
    })) as { transaction: { id: string } }
    createdTxIds.push(txResult.transaction.id)

    const { error } = (await callToolError(client, { name: 'delete_account', args: { name } })) as ErrorPayload<InUseError>
    expect(error.code).toBe('in_use')
    expect(error.entity).toBe('account')
    expect(error.references.transactions).toBeGreaterThanOrEqual(1)
  })

  it('delete_account blocked when a recurring rule references it', async () => {
    const name = `del-rec-acct-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    await callTool(client, {
      name: 'create_recurring',
      args: {
        description: `Recurring-del-${stamp}`,
        amount: 50,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-02-01',
        account: name,
      },
    })

    const { error } = (await callToolError(client, { name: 'delete_account', args: { name } })) as ErrorPayload<InUseError>
    expect(error.code).toBe('in_use')
    expect(error.references.recurring).toBeGreaterThanOrEqual(1)
  })

  it('delete_account blocked when account is a card payer', async () => {
    const name = `del-payer-acct-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    await callTool(client, {
      name: 'create_credit_card',
      args: { name: `card-payer-${stamp}`, closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: name },
    })

    const { error } = (await callToolError(client, { name: 'delete_account', args: { name } })) as ErrorPayload<InUseError>
    expect(error.code).toBe('in_use')
    expect(error.references.cards).toBeGreaterThanOrEqual(1)
  })

  it('delete_account rejects a credit account', async () => {
    const cardName = `credit-del-${stamp}`
    const payerName = `payer-del-${stamp}`
    await callTool(client, { name: 'create_account', args: { name: payerName, type: 'checking', currency: 'BRL' } })
    await callTool(client, { name: 'create_credit_card', args: { name: cardName, closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: payerName } })

    const creditAccountName = `Card: ${cardName}`
    const { error } = (await callToolError(client, { name: 'delete_account', args: { name: creditAccountName } })) as ErrorPayload<ValidationError>
    expect(error.code).toBe('validation')
  })

  it('delete_account returns unknown_account for non-existent name', async () => {
    const { error } = (await callToolError(client, { name: 'delete_account', args: { name: 'nonexistent-xyz-999' } })) as ErrorPayload<{ code: string }>
    expect(error.code).toBe('unknown_account')
  })

  // --- update_account ---

  it('update_account name + initialBalance succeeds even with transactions', async () => {
    const name = `upd-always-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL', initialBalance: 100 } })

    const txResult = (await callTool(client, {
      name: 'create_transaction',
      args: {
        description: `tx-for-upd-${stamp}`,
        amount: 10,
        type: 'expense',
        date: '2026-01-15',
        account: name,
        idempotencyKey: `upd-acct-tx-${stamp}`,
      },
    })) as { transaction: { id: string } }
    createdTxIds.push(txResult.transaction.id)

    const newName = `upd-always-renamed-${stamp}`
    const updated = (await callTool(client, {
      name: 'update_account',
      args: { name, newName, initialBalance: 500 },
    })) as Account
    expect(updated.name).toBe(newName)
    expect(updated.initialBalance).toBe(500)
  })

  it('update_account type blocked when transactions exist', async () => {
    const name = `upd-type-block-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    const txResult = (await callTool(client, {
      name: 'create_transaction',
      args: {
        description: `tx-type-${stamp}`,
        amount: 5,
        type: 'expense',
        date: '2026-01-15',
        account: name,
        idempotencyKey: `upd-type-tx-${stamp}`,
      },
    })) as { transaction: { id: string } }
    createdTxIds.push(txResult.transaction.id)

    const { error } = (await callToolError(client, {
      name: 'update_account',
      args: { name, type: 'savings' },
    })) as ErrorPayload<ValidationError>
    expect(error.code).toBe('validation')
    expect(error.issues[0]).toContain('type cannot be changed')
  })

  it('update_account type + currency allowed when no transactions', async () => {
    const name = `upd-type-ok-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    const updated = (await callTool(client, {
      name: 'update_account',
      args: { name, type: 'savings', currency: 'USD' },
    })) as Account
    expect(updated.type).toBe('savings')
    expect(updated.currency).toBe('USD')
  })

  it('update_account currency blocked when account is a card payer', async () => {
    const name = `upd-cur-payer-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    await callTool(client, {
      name: 'create_credit_card',
      args: { name: `card-cur-${stamp}`, closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: name },
    })

    const { error } = (await callToolError(client, {
      name: 'update_account',
      args: { name, currency: 'USD' },
    })) as ErrorPayload<ValidationError>
    expect(error.code).toBe('validation')
    expect(error.issues[0]).toContain('credit card payment account')
  })

  it('update_account rejects setting type to credit', async () => {
    const name = `upd-no-credit-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL' } })

    const { error } = (await callToolError(client, {
      name: 'update_account',
      args: { name, type: 'credit' },
    })) as ErrorPayload<ValidationError>
    expect(error.code).toBe('validation')
    expect(error.issues[0]).toContain('credit')
  })

  it('update_account rejects a credit account', async () => {
    const cardName = `credit-upd-${stamp}`
    const payerName = `payer-upd-${stamp}`
    await callTool(client, { name: 'create_account', args: { name: payerName, type: 'checking', currency: 'BRL' } })
    await callTool(client, { name: 'create_credit_card', args: { name: cardName, closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: payerName } })

    const creditAccountName = `Card: ${cardName}`
    const { error } = (await callToolError(client, {
      name: 'update_account',
      args: { name: creditAccountName, initialBalance: 999 },
    })) as ErrorPayload<ValidationError>
    expect(error.code).toBe('validation')
  })

  it('update_account rename to existing name returns duplicate_name', async () => {
    const name1 = `upd-dup-a-${stamp}`
    const name2 = `upd-dup-b-${stamp}`
    await callTool(client, { name: 'create_account', args: { name: name1, type: 'checking', currency: 'BRL' } })
    await callTool(client, { name: 'create_account', args: { name: name2, type: 'checking', currency: 'BRL' } })

    const { error } = (await callToolError(client, {
      name: 'update_account',
      args: { name: name1, newName: name2 },
    })) as ErrorPayload<{ code: string }>
    expect(error.code).toBe('duplicate_name')
  })

  it('update_account with no fields returns the account unchanged', async () => {
    const name = `upd-noop-${stamp}`
    await callTool(client, { name: 'create_account', args: { name, type: 'checking', currency: 'BRL', initialBalance: 42 } })

    const result = (await callTool(client, { name: 'update_account', args: { name } })) as Account
    expect(result.name).toBe(name)
    expect(result.type).toBe('checking')
    expect(result.currency).toBe('BRL')
    expect(result.initialBalance).toBe(42)
  })

  it('update_account returns unknown_account for non-existent name', async () => {
    const { error } = (await callToolError(client, {
      name: 'update_account',
      args: { name: 'nonexistent-xyz-999', initialBalance: 100 },
    })) as ErrorPayload<{ code: string }>
    expect(error.code).toBe('unknown_account')
  })
})
