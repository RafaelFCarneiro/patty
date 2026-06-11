import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Result } from 'neverthrow'
import { z } from 'zod'
import type { AppError } from '../../common/errors.js'
import { createAccount, listAccounts } from '../../controllers/accounts.js'
import { createCategory, listCategories } from '../../controllers/categories.js'
import type { Deps } from '../../controllers/deps.js'
import { getSpendingSummary } from '../../controllers/summary.js'
import {
  createTransaction,
  deleteTransaction,
  searchTransactions,
  updateTransaction,
} from '../../controllers/transactions.js'

/** Thin diplomat: MCP tools delegate to the same controllers as HTTP. */

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

const jsonError = (e: AppError) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: e }, null, 2) }],
  isError: true,
})

const fromResult = <T>(result: Result<T, AppError>) => result.match(json, jsonError)

export const buildMcpServer = (deps: Deps): McpServer => {
  const server = new McpServer({ name: 'fintrack', version: '0.1.0' })

  server.registerTool(
    'create_transaction',
    {
      title: 'Create transaction',
      description:
        'Create an expense or income from natural input. Resolves account/category by name; ' +
        'when category is omitted, classifies via the merchant graph and returns method + confidence ' +
        '(confirm with the user when confidence < 0.6). Idempotent via idempotencyKey — generate a ' +
        'stable key like "<date>-<description>-<amount>". Currency comes from the account, or the ' +
        'currency field (default BRL).',
      inputSchema: {
        description: z.string().describe('What was paid/received, e.g. "Uber para o aeroporto"'),
        amount: z.number().positive().describe('Positive amount in full units (reais/dollars)'),
        type: z.enum(['expense', 'income']),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; defaults to today'),
        account: z.string().optional().describe('Account name, e.g. "Nubank"'),
        category: z.string().optional().describe('Category name; omit to auto-classify'),
        currency: z.enum(['BRL', 'USD']).optional(),
        idempotencyKey: z.string().min(1),
        rawInput: z.string().optional().describe('Original user phrasing, for audit'),
      },
    },
    async (args) => fromResult(await createTransaction(deps, args, 'mcp')),
  )

  server.registerTool(
    'update_transaction',
    {
      title: 'Update transaction',
      description:
        'Update fields of an existing transaction by id (from search_transactions). Only provided fields ' +
        'change. Setting category counts as a user correction (confidence 1) and teaches the merchant graph. ' +
        'Changing the account also updates the currency to match it.',
      inputSchema: {
        id: z.string().min(1).describe('Transaction id'),
        description: z.string().min(1).optional(),
        amount: z.number().positive().optional(),
        type: z.enum(['expense', 'income']).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        account: z.string().optional().describe('New account name'),
        category: z.string().optional().describe('New category name (user correction)'),
      },
    },
    async (args) => fromResult(await updateTransaction(deps, args)),
  )

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete transaction',
      description:
        'Delete a transaction by id. Without confirm:true it is a DRY RUN returning what would be deleted — ' +
        'show it to the user, get explicit confirmation, then call again with confirm: true.',
      inputSchema: {
        id: z.string().min(1).describe('Transaction id'),
        confirm: z.boolean().default(false).describe('Must be true to actually delete'),
      },
    },
    async (args) => fromResult(await deleteTransaction(deps, args)),
  )

  server.registerTool(
    'search_transactions',
    {
      title: 'Search transactions',
      description:
        'Search transactions by period (month/year or from/to), type, category/account name, or free text.',
      inputSchema: {
        month: z.number().int().min(1).max(12).optional(),
        year: z.number().int().min(2000).max(2100).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        type: z.enum(['expense', 'income']).optional(),
        category: z.string().optional(),
        account: z.string().optional(),
        text: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (args) => fromResult(await searchTransactions(deps, args)),
  )

  server.registerTool(
    'get_spending_summary',
    {
      title: 'Get spending summary',
      description:
        'Income, expenses, balance and per-category totals for a month — grouped per currency (BRL/USD are never mixed).',
      inputSchema: {
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      },
    },
    async (args) => json(await getSpendingSummary(deps, args)),
  )

  server.registerTool(
    'create_account',
    {
      title: 'Create account',
      description: 'Create a bank account / wallet. Currency defaults to BRL.',
      inputSchema: {
        name: z.string().min(1),
        type: z.enum(['checking', 'savings', 'wallet', 'investment']).default('checking'),
        currency: z.enum(['BRL', 'USD']).default('BRL'),
      },
    },
    async (args) => fromResult(await createAccount(deps, args)),
  )

  server.registerTool(
    'list_accounts',
    { title: 'List accounts', description: 'List all accounts with their currencies.', inputSchema: {} },
    async () => json(await listAccounts(deps)),
  )

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description: 'Create a category. Prefer existing categories (list_categories) before creating new ones.',
      inputSchema: {
        name: z.string().min(1),
        kind: z.enum(['expense', 'income', 'both']).default('expense'),
      },
    },
    async (args) => fromResult(await createCategory(deps, args)),
  )

  server.registerTool(
    'list_categories',
    { title: 'List categories', description: 'List all categories.', inputSchema: {} },
    async () => json(await listCategories(deps)),
  )

  return server
}
