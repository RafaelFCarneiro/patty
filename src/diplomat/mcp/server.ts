import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Result } from 'neverthrow'
import { z } from 'zod'
import type { AppError } from '../../common/errors.js'
import { createAccount, listAccounts } from '../../controllers/accounts.js'
import { getBill, payBill } from '../../controllers/bills.js'
import { createCategory, listCategories } from '../../controllers/categories.js'
import { createCreditCard, listCreditCards } from '../../controllers/creditCards.js'
import type { Deps } from '../../controllers/deps.js'
import { applyDueRecurring, createRecurring, listRecurring } from '../../controllers/recurring.js'
import { getSpendingSummary } from '../../controllers/summary.js'
import {
  createTransaction,
  createTransactionsBulk,
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
        card: z.string().optional().describe('Credit card name — transaction joins the cycle bill (fatura). Use account OR card, not both'),
        category: z.string().optional().describe('Category name; omit to auto-classify'),
        currency: z.enum(['BRL', 'USD']).optional(),
        idempotencyKey: z.string().min(1),
        rawInput: z.string().optional().describe('Original user phrasing, for audit'),
      },
    },
    async (args) => fromResult(await createTransaction(deps, args, 'mcp')),
  )

  server.registerTool(
    'create_transactions_bulk',
    {
      title: 'Create transactions in bulk',
      description:
        'Import many transactions at once (pasted statement, CSV lines). Each item is auto-classified ' +
        'and idempotent (key derived from date+description+amount — re-importing is safe). Returns a ' +
        'per-item status: created, needs_review (low confidence — confirm categories with the user), ' +
        'duplicate, or error. Top-level account/card apply to items that do not set their own.',
      inputSchema: {
        items: z
          .array(
            z.object({
              description: z.string().min(1),
              amount: z.number().positive(),
              type: z.enum(['expense', 'income']),
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
              account: z.string().optional(),
              card: z.string().optional(),
              category: z.string().optional(),
              currency: z.enum(['BRL', 'USD']).optional(),
              idempotencyKey: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
        account: z.string().optional().describe('Default account for all items'),
        card: z.string().optional().describe('Default credit card for all items'),
        rawInput: z.string().optional().describe('The original pasted statement text'),
      },
    },
    async (args) => fromResult(await createTransactionsBulk(deps, args, 'import')),
  )

  server.registerTool(
    'create_credit_card',
    {
      title: 'Create credit card',
      description:
        'Create a credit card. closingDay: day the fatura closes (transactions after it go to next ' +
        "month's bill). dueDay: payment due day. Currency defaults to BRL.",
      inputSchema: {
        name: z.string().min(1),
        closingDay: z.number().int().min(1).max(28),
        dueDay: z.number().int().min(1).max(28),
        currency: z.enum(['BRL', 'USD']).default('BRL'),
        limit: z.number().positive().optional(),
      },
    },
    async (args) => fromResult(await createCreditCard(deps, args)),
  )

  server.registerTool(
    'list_credit_cards',
    { title: 'List credit cards', description: 'List all credit cards.', inputSchema: {} },
    async () => json(await listCreditCards(deps)),
  )

  server.registerTool(
    'get_bill',
    {
      title: 'Get credit card bill (fatura)',
      description:
        'Get a card bill for a month: status (open/closed/paid), close/due dates, total, and its transactions.',
      inputSchema: {
        card: z.string().min(1).describe('Card name'),
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      },
    },
    async (args) => fromResult(await getBill(deps, args)),
  )

  server.registerTool(
    'pay_bill',
    {
      title: 'Pay credit card bill',
      description:
        'Mark a bill as paid. Does NOT create a payment transaction (card expenses are already counted; ' +
        'a payment expense would double-count).',
      inputSchema: {
        card: z.string().min(1),
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      },
    },
    async (args) => fromResult(await payBill(deps, args)),
  )

  server.registerTool(
    'create_recurring',
    {
      title: 'Create recurring rule',
      description:
        'Create a recurring transaction rule (salary, rent, subscription). Materialized by apply_due_recurring.',
      inputSchema: {
        description: z.string().min(1),
        amount: z.number().positive(),
        type: z.enum(['expense', 'income']),
        period: z.enum(['weekly', 'monthly', 'yearly']),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('First due date'),
        account: z.string().optional(),
        category: z.string().optional(),
        currency: z.enum(['BRL', 'USD']).optional(),
      },
    },
    async (args) => fromResult(await createRecurring(deps, args)),
  )

  server.registerTool(
    'list_recurring',
    { title: 'List recurring rules', description: 'List all recurring rules with next due dates.', inputSchema: {} },
    async () => json(await listRecurring(deps)),
  )

  server.registerTool(
    'apply_due_recurring',
    {
      title: 'Apply due recurring rules',
      description:
        'Materialize transactions for every rule due on/before today (catches up missed periods). ' +
        'Idempotent — safe to call any time.',
      inputSchema: {},
    },
    async () => json(await applyDueRecurring(deps)),
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
