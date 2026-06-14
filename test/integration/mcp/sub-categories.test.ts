import { afterEach, describe, expect, it } from 'vitest'
import { callTool, callToolError, deleteTransactions, ensure, makeClient } from './helpers.js'

// Sub-categories have no delete tool — the ephemeral test DB is wiped per run.
// We only need to clean up transactions to avoid cross-test interference.
const createdTxIds: string[] = []

afterEach(async () => {
  await deleteTransactions([...createdTxIds])
  createdTxIds.length = 0
})

type SubCategory = { id?: string; name?: string; parentId?: string; parentName?: string; kind?: string }
type TransactionView = { id?: string; subCategoryId?: string; subCategoryName?: string; categoryId?: string; categoryName?: string }

describe('MCP integration > sub-categories', () => {
  it('create_sub_category returns sub-category with parent info inherited kind', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Restaurante-${stamp}`, parentId: 'cat-alimentacao' },
      })) as SubCategory

      ensure(sc.id, 'subCategory id missing')
      expect(sc.name).toBe(`Restaurante-${stamp}`)
      expect(sc.parentId).toBe('cat-alimentacao')
      expect(sc.parentName).toBe('Alimentação')
      expect(sc.kind).toBe('expense')
    } finally {
      await transport.close()
    }
  })

  it('create_sub_category rejects duplicate name within same parent', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Mercado-${stamp}`, parentId: 'cat-alimentacao' },
      })
      await expect(
        callTool(client, {
          name: 'create_sub_category',
          args: { name: `Mercado-${stamp}`, parentId: 'cat-alimentacao' },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('list_sub_categories returns created sub-category', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Padaria-${stamp}`, parentId: 'cat-alimentacao' },
      })) as SubCategory
      ensure(sc.id, 'subCategory id missing')

      const all = (await callTool(client, { name: 'list_sub_categories', args: {} })) as SubCategory[]
      expect(Array.isArray(all)).toBe(true)
      expect(all.some((s) => s.id === sc.id)).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('list_sub_categories filtered by parentId only returns children of that parent', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Uber-${stamp}`, parentId: 'cat-transporte' },
      })
      await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Ifood-${stamp}`, parentId: 'cat-alimentacao' },
      })

      const food = (await callTool(client, {
        name: 'list_sub_categories',
        args: { parentId: 'cat-alimentacao' },
      })) as SubCategory[]

      expect(food.every((s) => s.parentId === 'cat-alimentacao')).toBe(true)
      expect(food.some((s) => s.name === `Ifood-${stamp}`)).toBe(true)
      expect(food.some((s) => s.name === `Uber-${stamp}`)).toBe(false)
    } finally {
      await transport.close()
    }
  })

  it('create_transaction with subCategory sets subCategoryId, subCategoryName, and parent categoryId', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Almoço-${stamp}`, parentId: 'cat-alimentacao' },
      })) as SubCategory
      ensure(sc.id, 'subCategory id missing')

      const result = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Almoço no restaurante',
          amount: 45,
          type: 'expense',
          subCategory: `Almoço-${stamp}`,
          idempotencyKey: `test-subcat-create-${stamp}`,
        },
      })) as { transaction?: TransactionView }

      const tx = result.transaction ?? (result as TransactionView)
      ensure(tx.id, 'transaction id missing')
      createdTxIds.push(tx.id)

      expect(tx.subCategoryId).toBe(sc.id)
      expect(tx.subCategoryName).toBe(`Almoço-${stamp}`)
      expect(tx.categoryId).toBe('cat-alimentacao')
      expect(tx.categoryName).toBe('Alimentação')
    } finally {
      await transport.close()
    }
  })

  it('create_transaction rejects expense transaction with income-only category', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      await expect(
        callTool(client, {
          name: 'create_transaction',
          args: {
            description: 'Pagamento errado',
            amount: 100,
            type: 'expense',
            category: 'Salário',
            idempotencyKey: `test-kind-mismatch-${stamp}`,
          },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('create_transaction rejects income transaction with expense-only category', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      await expect(
        callTool(client, {
          name: 'create_transaction',
          args: {
            description: 'Salário errado',
            amount: 5000,
            type: 'income',
            category: 'Alimentação',
            idempotencyKey: `test-income-mismatch-${stamp}`,
          },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('create_transaction rejects providing both category and subCategory', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      await expect(
        callTool(client, {
          name: 'create_transaction',
          args: {
            description: 'Ambiguous',
            amount: 10,
            type: 'expense',
            category: 'Alimentação',
            subCategory: 'something',
            idempotencyKey: `test-both-${stamp}`,
          },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('update_transaction replaces sub-category', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const sc1 = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `SubA-${stamp}`, parentId: 'cat-alimentacao' },
      })) as SubCategory
      const sc2 = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `SubB-${stamp}`, parentId: 'cat-alimentacao' },
      })) as SubCategory
      ensure(sc1.id, 'sc1 id missing')
      ensure(sc2.id, 'sc2 id missing')

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Refeição',
          amount: 30,
          type: 'expense',
          subCategory: `SubA-${stamp}`,
          idempotencyKey: `test-update-subcat-${stamp}`,
        },
      })) as { transaction?: TransactionView }
      const tx = created.transaction ?? (created as TransactionView)
      ensure(tx.id, 'transaction id missing')
      createdTxIds.push(tx.id)

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: tx.id, subCategory: `SubB-${stamp}` },
      })) as TransactionView

      expect(updated.subCategoryId).toBe(sc2.id)
      expect(updated.subCategoryName).toBe(`SubB-${stamp}`)
      expect(updated.categoryId).toBe('cat-alimentacao')
    } finally {
      await transport.close()
    }
  })

  it('search_transactions filters by subCategory', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Filter-${stamp}`, parentId: 'cat-alimentacao' },
      })) as SubCategory
      ensure(sc.id, 'subCategory id missing')

      const tx1 = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Com subcategoria',
          amount: 20,
          type: 'expense',
          subCategory: `Filter-${stamp}`,
          idempotencyKey: `test-search-sub-match-${stamp}`,
        },
      })) as { transaction?: TransactionView }
      const tx2 = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Sem subcategoria',
          amount: 20,
          type: 'expense',
          category: 'Alimentação',
          idempotencyKey: `test-search-sub-no-match-${stamp}`,
        },
      })) as { transaction?: TransactionView }

      const t1 = tx1.transaction ?? (tx1 as TransactionView)
      const t2 = tx2.transaction ?? (tx2 as TransactionView)
      ensure(t1.id, 'tx1 id missing')
      ensure(t2.id, 'tx2 id missing')
      createdTxIds.push(t1.id, t2.id)

      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { subCategory: `Filter-${stamp}` },
      })) as TransactionView[]

      expect(results.some((t) => t.id === t1.id)).toBe(true)
      expect(results.some((t) => t.id === t2.id)).toBe(false)
    } finally {
      await transport.close()
    }
  })

  it('category_kind_mismatch error includes a hint with the corrective type', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const result = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: 'Teste hint',
          amount: 100,
          type: 'expense',
          category: 'Salário',
          idempotencyKey: `test-hint-${stamp}`,
        },
      })) as { error?: { code?: string; hint?: string } }

      expect(result.error?.code).toBe('category_kind_mismatch')
      expect(result.error?.hint).toContain('set type: "income"')
    } finally {
      await transport.close()
    }
  })

  it('create_sub_category rejects unknown parentId with structured error', async () => {
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      await expect(
        callTool(client, {
          name: 'create_sub_category',
          args: { name: 'Anything', parentId: 'cat-does-not-exist' },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('update_transaction rejects setting a category on a transfer transaction', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const srcName = `TransferSrc-${stamp}`
      const dstName = `TransferDst-${stamp}`
      await callTool(client, { name: 'create_account', args: { name: srcName, type: 'checking', currency: 'BRL', initialBalance: 500 } })
      await callTool(client, { name: 'create_account', args: { name: dstName, type: 'savings', currency: 'BRL', initialBalance: 0 } })

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: { from: srcName, to: dstName, amount: 100, idempotencyKey: `test-transfer-cat-${stamp}` },
      })) as { transaction?: TransactionView }
      const tx = transfer.transaction ?? (transfer as TransactionView)
      ensure(tx.id, 'transfer id missing')
      createdTxIds.push(tx.id)

      await expect(
        callTool(client, {
          name: 'update_transaction',
          args: { id: tx.id, category: 'Alimentação' },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('update_transaction rejects kind mismatch when only subCategory changes (no type provided)', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      // Create an expense transaction (no category)
      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Despesa genérica',
          amount: 50,
          type: 'expense',
          idempotencyKey: `test-kind-update-${stamp}`,
        },
      })) as { transaction?: TransactionView }
      const tx = created.transaction ?? (created as TransactionView)
      ensure(tx.id, 'transaction id missing')
      createdTxIds.push(tx.id)

      // Attempt to update to a income-only category without providing type
      await expect(
        callTool(client, {
          name: 'update_transaction',
          args: { id: tx.id, category: 'Salário' },
        }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })
})
