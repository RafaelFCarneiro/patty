import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Result } from 'neverthrow';
import { z } from 'zod';
import type { AppError } from '../../common/errors.js';
import {
  createAccount,
  deleteAccount,
  getAccountBalances,
  listAccounts,
  updateAccount,
} from '../../controllers/account/account.js';
import {
  addAccountExpense,
  addAccountIncome,
  deleteAccountTransaction,
  importAccountStatement,
  updateAccountTransaction,
} from '../../controllers/account/transaction.js';
import { aggregateSpending } from '../../controllers/aggregate.js';
import { getBill, payBill, revertBillPayment } from '../../controllers/creditCard/bill.js';
import { listDashboards, saveDashboard } from '../../controllers/dashboards.js';
import {
  createCategory,
  createSubCategory,
  deleteCategory,
  deleteSubCategory,
  listCategories,
  listSubCategories,
} from '../../controllers/categories.js';
import { getPreferences, setLocale } from '../../controllers/settings.js';
import { getStatus } from '../../controllers/status.js';
import { createCreditCard, deleteCreditCard, listCreditCards } from '../../controllers/creditCard/creditCard.js';
import {
  addCardPurchase,
  deleteCardTransaction,
  importCardStatement,
  updateCardTransaction,
} from '../../controllers/creditCard/transaction.js';
import type { Deps } from '../../controllers/deps.js';
import { applyDueRecurring, createRecurring, listRecurring } from '../../controllers/recurring.js';
import { createTag, deleteTag, listTags } from '../../controllers/tags.js';
import { getSpendingSummary } from '../../controllers/summary.js';
import { confirmTransaction } from '../../controllers/transaction/core.js';
import { searchTransactions } from '../../controllers/transaction/read.js';
import { createTransfer } from '../../controllers/account/transfer.js';
import {
  AggregateMetric,
  AggregateSort,
  AggregateSpendingSchema,
  type ResolvedAggregateSpending,
} from '../../models/aggregate.js';
import { SortDirection } from '../../models/page.js';
import {
  TransactionSource,
  TransactionTool,
  DeleteTransactionSchema,
  SearchTransactionsSchema,
  TransactionSortField,
} from '../../models/transaction.js';
import { CreateCategorySchema, CreateSubCategorySchema } from '../../wire/in/categories.js';
import { Locale, LocaleSource } from '../../models/locale.js';
import { AccountType } from '../../models/account.js';
import { BillQuerySchema, PayBillSchema } from '../../models/bill.js';
import { SaveDashboardSchema } from '../../models/dashboard.js';
import { CreateRecurringSchema } from '../../wire/in/recurring.js';
import {
  AddCardPurchaseSchema,
  CreateCreditCardSchema,
  ImportCardStatementSchema,
  UpdateCardTransactionSchema,
} from '../../wire/in/creditCards.js';
import { bulkResultToWireOut, createResultToWireOut, deleteResultToWireOut } from '../../adapters/transactions.js';
import {
  addCardPurchaseWireInToModel,
  importCardStatementWireInToModel,
  updateCardTransactionWireInToModel,
} from '../../adapters/creditCards.js';
import {
  AddAccountMovementSchema,
  CreateAccountSchema,
  CreateTransferSchema,
  ImportAccountStatementSchema,
  UpdateAccountSchema,
  UpdateAccountTransactionSchema,
} from '../../wire/in/accounts.js';
import { CreateTagSchema } from '../../wire/in/tags.js';
import * as accountAdapters from '../../adapters/accounts.js';
import { buildOpenApiDocument } from '../http/openapi.js';
import { buildRouteDefinitions } from '../http/routes.js';

/** Thin diplomat: MCP tools delegate to the same controllers as HTTP. */

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const jsonError = (e: AppError) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: e }, null, 2) }],
  isError: true,
});

const fromResult = <T>(result: Result<T, AppError>) => result.match(json, jsonError);

/** Shared by add_account_expense/add_account_income (ADR-016) — identical aside from which
 *  movement kind is being recorded. */
const addAccountMovementDescription = (movement: 'expense' | 'income'): string =>
  `Record ${movement === 'expense' ? 'an expense from' : 'income into'} a bank account / wallet — the ` +
  "account aggregate's movement entry point (ADR-016). Resolves the account and category by name; " +
  'when category is omitted, classifies via learned merchant→category associations and returns method + ' +
  'confidence (confirm with the user when confidence < 0.6). Idempotent via idempotencyKey — generate a ' +
  'stable key like "<date>-<description>-<amount>". Currency comes from the account, or the currency field ' +
  `(default USD). Omitting account records an unattached ${movement === 'expense' ? '(e.g. cash) expense' : 'income'}.`;

/** Shared by import_card_statement/import_account_statement (ADR-017 step 2) — the per-item
 *  classification/idempotency/result-status contract is identical for both single-source importers. */
const STATEMENT_IMPORT_RESULT_DESCRIPTION =
  'Each item is auto-classified and idempotent (key derived from date+description+amount when absent — ' +
  're-importing is safe). Returns a per-item status: created, needs_review (low confidence — confirm ' +
  'categories with the user), duplicate, or error.';

export const buildMcpServer = (deps: Deps, version: string): McpServer => {
  const server = new McpServer({ name: 'fintrack', version });

  const openApiDocument = buildOpenApiDocument(buildRouteDefinitions(deps, version), version);
  server.registerResource(
    'openapi',
    'fintrack://openapi',
    {
      title: 'FinTrack OpenAPI contract',
      description:
        'OpenAPI 3.0 document for the REST API (GET /api/openapi.json mirrors this). ' +
        'Read this before generating fetch() calls against /api endpoints (ADR-013).',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(openApiDocument, null, 2) }],
    }),
  );

  server.registerTool(
    'import_card_statement',
    {
      title: 'Import a credit-card statement',
      description:
        'Import a credit-card statement (pasted text, CSV lines) — every item is a purchase on the ONE ' +
        "card named at the top level, joining each item's cycle bill (fatura). Single-source: the " +
        "credit-card aggregate's bulk entry point (ADR-017) — use import_account_statement instead for a " +
        `bank/wallet statement. ${STATEMENT_IMPORT_RESULT_DESCRIPTION}`,
      inputSchema: ImportCardStatementSchema.shape,
    },
    async (args) =>
      fromResult(
        (
          await importCardStatement(deps, importCardStatementWireInToModel(args), TransactionSource.enum.import)
        ).map(bulkResultToWireOut),
      ),
  );

  server.registerTool(
    'add_card_purchase',
    {
      title: 'Add credit-card purchase',
      description:
        "Record a credit-card purchase, joining the cycle bill (fatura) — the credit-card aggregate's " +
        'purchase entry point (ADR-016). Resolves the card and category by ' +
        'name; when category is omitted, classifies via learned merchant→category associations and returns ' +
        'method + confidence (confirm with the user when confidence < 0.6). Idempotent via idempotencyKey — ' +
        'generate a stable key like "<date>-<description>-<amount>". Currency always comes from the card ' +
        "(a card's currency is fixed at creation) — the currency field is accepted for schema symmetry " +
        'with add_account_expense/add_account_income but has no effect here.',
      inputSchema: AddCardPurchaseSchema.shape,
    },
    async (args) =>
      fromResult(
        (await addCardPurchase(deps, addCardPurchaseWireInToModel(args), TransactionSource.enum.mcp)).map(
          createResultToWireOut,
        ),
      ),
  );

  server.registerTool(
    'add_account_expense',
    {
      title: 'Add account expense',
      description: addAccountMovementDescription('expense'),
      inputSchema: AddAccountMovementSchema.shape,
    },
    async (args) => {
      const model = accountAdapters.addAccountMovementWireInToModel(args);
      return fromResult((await addAccountExpense(deps, model, TransactionSource.enum.mcp)).map(createResultToWireOut));
    },
  );

  server.registerTool(
    'add_account_income',
    {
      title: 'Add account income',
      description: addAccountMovementDescription('income'),
      inputSchema: AddAccountMovementSchema.shape,
    },
    async (args) => {
      const model = accountAdapters.addAccountMovementWireInToModel(args);
      return fromResult((await addAccountIncome(deps, model, TransactionSource.enum.mcp)).map(createResultToWireOut));
    },
  );

  server.registerTool(
    'import_account_statement',
    {
      title: 'Import an account statement',
      description:
        'Import a bank/wallet statement (pasted text, CSV lines) — every item is an expense or income ' +
        "(per item's `type`) on the ONE account named at the top level (omit to record unattached, e.g. " +
        "cash, movements) — the account aggregate's bulk entry point (ADR-017) — use import_card_statement " +
        `instead for a credit-card statement. ${STATEMENT_IMPORT_RESULT_DESCRIPTION}`,
      inputSchema: ImportAccountStatementSchema.shape,
    },
    async (args) => {
      const model = accountAdapters.importAccountStatementWireInToModel(args);
      return fromResult(
        (await importAccountStatement(deps, model, TransactionSource.enum.import)).map(bulkResultToWireOut),
      );
    },
  );

  server.registerTool(
    'create_credit_card',
    {
      title: 'Create credit card',
      description:
        'Create a credit card with its internal liability account (ADR-010). closingDay: day the fatura ' +
        "closes (transactions after it go to next month's bill). dueDay: payment due day. Currency " +
        'defaults to USD. The card auto-creates an internal credit account that tracks outstanding debt.',
      inputSchema: CreateCreditCardSchema.shape,
    },
    async (args) => fromResult(await createCreditCard(deps, args)),
  );

  server.registerTool(
    'list_credit_cards',
    { title: 'List credit cards', description: 'List all credit cards.', inputSchema: {} },
    async () => json(await listCreditCards(deps)),
  );

  server.registerTool(
    'delete_credit_card',
    {
      title: 'Delete credit card',
      description:
        'Hard delete a credit card and everything associated: internal credit account, all purchases, ' +
        'bill payments, and bills. Without confirm:true it is a DRY RUN returning what would be deleted — ' +
        'show it to the user and call again with confirm: true. Irreversible.',
      inputSchema: {
        card: z.string().min(1).describe('Card name'),
        confirm: z.boolean().default(false).describe('Must be true to actually delete'),
      },
    },
    async (args) => fromResult(await deleteCreditCard(deps, args)),
  );

  server.registerTool(
    'get_bill',
    {
      title: 'Get credit card bill (fatura)',
      description:
        'Get a card bill for a month: status (open/closed/paid), close/due dates, total, and its transactions.',
      inputSchema: BillQuerySchema.shape,
    },
    async (args) => fromResult(await getBill(deps, args)),
  );

  server.registerTool(
    'pay_bill',
    {
      title: 'Pay credit card bill',
      description:
        'Pay a credit card bill. Creates a canonical transfer (payer account → card internal account) ' +
        'for the full bill total, then marks the bill paid. Idempotent — re-calling on a paid bill is a no-op. ' +
        'Paying account resolution: explicit `account` → card default `paymentAccount` → error.',
      inputSchema: PayBillSchema.shape,
    },
    async (args) => fromResult(await payBill(deps, { ...args, source: TransactionSource.enum.mcp })),
  );

  server.registerTool(
    'revert_bill_payment',
    {
      title: 'Revert credit card bill payment',
      description:
        'Undo a bill payment: deletes the payment transfer and flips the bill back from paid to closed. ' +
        'Idempotent — calling on a bill that is not paid is a no-op that returns it unchanged.',
      inputSchema: BillQuerySchema.shape,
    },
    async (args) => fromResult(await revertBillPayment(deps, args)),
  );

  server.registerTool(
    'create_recurring',
    {
      title: 'Create recurring rule',
      description:
        'Create a recurring transaction rule (salary, rent, subscription). Materialized by apply_due_recurring.',
      inputSchema: CreateRecurringSchema.shape,
    },
    async (args) => fromResult(await createRecurring(deps, args)),
  );

  server.registerTool(
    'list_recurring',
    { title: 'List recurring rules', description: 'List all recurring rules with next due dates.', inputSchema: {} },
    async () => json(await listRecurring(deps)),
  );

  server.registerTool(
    'apply_due_recurring',
    {
      title: 'Apply due recurring rules',
      description:
        'Materialize transactions for every rule due on/before `through` (default: today). ' +
        'Past/present occurrences are created as effective; future occurrences are created as pending — ' +
        'so passing a future date pre-creates upcoming salary, rent, and subscriptions as pending, ' +
        'feeding projections without extra monthly effort. Idempotent — safe to call any time.',
      inputSchema: {
        through: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'YYYY-MM-DD horizon (default: today). Pass a future date to pre-create upcoming occurrences as pending.',
          ),
      },
    },
    async (args) => json(await applyDueRecurring(deps, args)),
  );

  server.registerTool(
    'confirm_transaction',
    {
      title: 'Confirm (clear) a pending transaction',
      description:
        'Mark a pending transaction as effective (cleared). ' +
        'Pending transactions are excluded from balances and spending summaries; confirming one makes it count. ' +
        'If the transaction is already effective, this is a no-op.',
      inputSchema: {
        id: z.string().min(1).describe('Transaction id (from search_transactions with status: "pending")'),
      },
    },
    async (args) => fromResult(await confirmTransaction(deps, args)),
  );

  server.registerTool(
    TransactionTool.updateCardTransaction,
    {
      title: 'Update credit-card transaction',
      description:
        "Update a credit-card transaction by id (from search_transactions) — the credit-card aggregate's " +
        'update entry point (ADR-017/ADR-020). Owns transactions that involve a credit account: card ' +
        'purchases (including the brief self-heal window before bill attachment) and the bill-payment ' +
        'transfer. cardId/billId (returned by search_transactions/TransactionView) are reliable proxies ' +
        'for picking this tool — only these two cases ever have a credit-account leg — but TransactionView ' +
        'does not expose account types, and the authoritative check is the leg account type; if unsure ' +
        "(e.g. a transfer's toAccountId), call the tool and follow the wrong-tool redirect. Calling this " +
        'on a transaction with no credit-account leg is rejected with a validation error redirecting to ' +
        `${TransactionTool.updateAccountTransaction}. Only provided fields ` +
        'change. Setting category is a user correction (confidence 1, strengthens the merchant→category ' +
        "association). account cannot be changed — a card purchase is always funded by the card's own " +
        'internal liability account (ADR-010). billMonth+billYear reassigns to a different bill cycle ' +
        '(both required together); rejected with a validation error pointing at revert_bill_payment if the ' +
        'current or target bill is paid. The bill-payment transfer itself (billId set, no cardId) cannot ' +
        'be edited at all — it is owned exclusively by pay_bill/revert_bill_payment.',
      inputSchema: UpdateCardTransactionSchema.shape,
    },
    async (args) =>
      fromResult(await updateCardTransaction(deps, updateCardTransactionWireInToModel(args))),
  );

  server.registerTool(
    TransactionTool.deleteCardTransaction,
    {
      title: 'Delete credit-card transaction',
      description:
        "Delete a credit-card transaction by id — the credit-card aggregate's delete entry point " +
        '(ADR-017/ADR-020). Owns transactions that involve a credit account (card purchases and the ' +
        'bill-payment transfer); calling this on a transaction with no credit-account leg is rejected with ' +
        `a validation error redirecting to ${TransactionTool.deleteAccountTransaction}. Without confirm:true ` +
        'it is a DRY RUN returning what would be deleted — show it to the user and call again with ' +
        'confirm: true. Any transaction on a paid bill (including the bill-payment transfer itself) cannot ' +
        'be deleted this way — rejected with a validation error pointing at revert_bill_payment.',
      inputSchema: DeleteTransactionSchema.shape,
    },
    async (args) => fromResult((await deleteCardTransaction(deps, args)).map(deleteResultToWireOut)),
  );

  server.registerTool(
    TransactionTool.updateAccountTransaction,
    {
      title: 'Update account transaction',
      description:
        "Update an account transaction by id (from search_transactions) — the account aggregate's update " +
        'entry point (ADR-017/ADR-020). Owns transactions that involve no credit account: account ' +
        'expenses/income and ordinary transfers. Absent cardId/billId (returned by search_transactions/ ' +
        'TransactionView) is a reliable proxy for picking this tool, but TransactionView does not expose ' +
        'account types and the authoritative check is the leg account type; if unsure (e.g. an ordinary ' +
        "transfer's toAccountId), call the tool and follow the wrong-tool redirect. Calling this on a " +
        'transaction that involves a credit account is rejected with a validation error redirecting to ' +
        `${TransactionTool.updateCardTransaction}. Only provided fields change. Setting category is a ` +
        'user correction (confidence 1, strengthens the merchant→category association). Changing account ' +
        'also updates currency to match it. Transfer transactions cannot have their type changed and ' +
        'cannot receive a category/subCategory (both rejected with a validation error).',
      inputSchema: UpdateAccountTransactionSchema.shape,
    },
    async (args) =>
      fromResult(
        await updateAccountTransaction(deps, accountAdapters.updateAccountTransactionWireInToModel(args)),
      ),
  );

  server.registerTool(
    TransactionTool.deleteAccountTransaction,
    {
      title: 'Delete account transaction',
      description:
        "Delete an account transaction by id — the account aggregate's delete entry point " +
        '(ADR-017/ADR-020). Owns transactions that involve no credit account (account expenses/income, ' +
        'ordinary transfers); calling this on a transaction that involves a credit account is rejected ' +
        `with a validation error redirecting to ${TransactionTool.deleteCardTransaction}. Without ` +
        'confirm:true it is a DRY RUN returning what would be deleted — show it to the user and call ' +
        'again with confirm: true.',
      inputSchema: DeleteTransactionSchema.shape,
    },
    async (args) => fromResult((await deleteAccountTransaction(deps, args)).map(deleteResultToWireOut)),
  );

  server.registerTool(
    'search_transactions',
    {
      title: 'Search transactions',
      description:
        'Search transactions by period (month/year or from/to), type (including transfers), ' +
        'category/account name, or free text. With an account filter this is the full account ' +
        'statement (extrato): expenses, income, and transfers in either direction. Returns a page ' +
        '`{ items, nextCursor?, total? }` (ADR-014) — pass the previous `nextCursor` back as `cursor` ' +
        'to keep walking; `nextCursor` is absent on the last page. `sort`/`dir` must stay the same ' +
        'across a walk (they are bound to the cursor); set `includeTotal: true` on the first call ' +
        'only if you need the total count of matching transactions.',
      inputSchema: {
        ...SearchTransactionsSchema.shape,
        limit: SearchTransactionsSchema.shape.limit.optional().default(50),
        sort: SearchTransactionsSchema.shape.sort.optional().default(TransactionSortField.enum.date),
        dir: SearchTransactionsSchema.shape.dir.optional().default(SortDirection.enum.desc),
      },
    },
    async (args) => fromResult(await searchTransactions(deps, args)),
  );

  server.registerTool(
    'aggregate_spending',
    {
      title: 'Aggregate spending',
      description:
        'Flexible spending aggregation: group transactions by category, account, tag, month, or merchant, ' +
        'measured as sum, count, or avg. Results are per-currency blocks with totals and percentages. ' +
        'Only effective, non-transfer transactions are counted. Provide a period via month+year or from/to date range.',
      inputSchema: {
        ...AggregateSpendingSchema.shape,
        metric: AggregateSpendingSchema.shape.metric.default(AggregateMetric.enum.sum),
        sort: AggregateSpendingSchema.shape.sort.default(AggregateSort.enum.desc),
        limit: AggregateSpendingSchema.shape.limit.default(50),
      },
    },
    async (args) => fromResult(await aggregateSpending(deps, args as ResolvedAggregateSpending)),
  );

  server.registerTool(
    'get_spending_summary',
    {
      title: 'Get spending summary',
      description:
        'Income, expenses, balance and per-category totals for a month — ' +
        'grouped per currency (BRL/USD are never mixed).',
      inputSchema: {
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      },
    },
    async (args) => json(await getSpendingSummary(deps, args)),
  );

  server.registerTool(
    'create_account',
    {
      title: 'Create account',
      description:
        'Create a bank account / wallet. Type defaults to checking, currency to USD. ' +
        'Note: credit accounts are created automatically with a credit card (create_credit_card).',
      inputSchema: CreateAccountSchema.shape,
    },
    async (args) => fromResult(await createAccount(deps, accountAdapters.createWireInToModel(args))),
  );

  server.registerTool(
    'get_account_balances',
    {
      title: 'Get account balances',
      description:
        'Current balance per account, derived: initialBalance + income − expenses ' +
        '+ transfers in − transfers out. Optionally filter by account name or type.',
      inputSchema: {
        account: z.string().optional().describe('Single account by name'),
        type: AccountType.optional(),
        projectedAsOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'YYYY-MM-DD. When provided, also returns projectedBalance = effective balance + pending ' +
              'transactions dated on/before this date. The effective balance is always included.',
          ),
      },
    },
    async (args) => fromResult(await getAccountBalances(deps, args)),
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description: 'List accounts with their currencies, optionally filtered by type (checking = conta corrente).',
      inputSchema: {
        type: AccountType.optional(),
      },
    },
    async (args) => json(await listAccounts(deps, args.type)),
  );

  server.registerTool(
    'update_account',
    {
      title: 'Update account',
      description:
        'Update a bank account. name (via newName) and initialBalance are always editable. ' +
        'type is only editable when the account has no transactions/transfers (and cannot be set to credit). ' +
        'currency is only editable when the account has no transactions/transfers, ' +
        'no recurring rules, and is not a credit card payment account. ' +
        'Credit accounts (card-managed) are rejected — use the card flow.',
      inputSchema: UpdateAccountSchema.shape,
    },
    async (args) => fromResult(await updateAccount(deps, accountAdapters.updateWireInToModel(args))),
  );

  server.registerTool(
    'delete_account',
    {
      title: 'Delete account',
      description:
        'Delete a bank account by name. Blocked if any transactions, transfers, recurring rules, or credit cards ' +
        'reference it — returns an in_use error with reference counts ' +
        'so you can guide the user to clear them first. ' +
        'Credit accounts (card-managed) are rejected — use delete_credit_card instead.',
      inputSchema: {
        name: z.string().min(1).describe('Account name'),
      },
    },
    async (args) => fromResult(await deleteAccount(deps, args.name)),
  );

  server.registerTool(
    'create_transfer',
    {
      title: 'Transfer between accounts',
      description:
        'Move value between two accounts (e.g. conta corrente → investimentos). Creates a transaction ' +
        "with type 'transfer' (FROM + TO accounts): debits one balance, credits the other, never appears " +
        'in spending summaries, and shows in both account histories (search_transactions). Both accounts ' +
        'must share the same currency (FX not available yet). Idempotent via idempotencyKey.',
      inputSchema: CreateTransferSchema.shape,
    },
    async (args) => fromResult(await createTransfer(deps, args, TransactionSource.enum.mcp)),
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description: 'Create a category. Prefer existing categories (list_categories) before creating new ones.',
      inputSchema: CreateCategorySchema.shape,
    },
    async (args) => fromResult(await createCategory(deps, args)),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description: 'List all categories. Names are resolved to the active locale for default categories.',
      inputSchema: {},
    },
    async () => json(await listCategories(deps)),
  );

  server.registerTool(
    'create_sub_category',
    {
      title: 'Create sub-category',
      description:
        'Create a sub-category under an existing category. Sub-categories inherit the kind (expense/income/both) ' +
        'of their parent. Use list_categories to find the parent id. Names must be unique within the same parent.',
      inputSchema: CreateSubCategorySchema.shape,
    },
    async (args) => fromResult(await createSubCategory(deps, args)),
  );

  server.registerTool(
    'list_sub_categories',
    {
      title: 'List sub-categories',
      description: 'List all sub-categories, optionally filtered by parent category id.',
      inputSchema: {
        parentId: z.string().optional().describe('Filter to sub-categories of this parent category id'),
      },
    },
    async (args) => json(await listSubCategories(deps, args.parentId)),
  );

  server.registerTool(
    'delete_category',
    {
      title: 'Delete category',
      description:
        'Delete a category by name. Blocked if any transactions, recurring rules, or sub-categories reference it — ' +
        'returns an in_use error with reference counts so you can guide the user to clear them first. ' +
        "On success, also removes the category's learned merchant classification rules (re-learnable).",
      inputSchema: { name: z.string().min(1).describe('Category name') },
    },
    async (args) => fromResult(await deleteCategory(deps, args.name)),
  );

  server.registerTool(
    'delete_sub_category',
    {
      title: 'Delete sub-category',
      description:
        'Delete a sub-category by name. Blocked if any transactions, recurring rules, ' +
        'or child sub-categories reference it — ' +
        'returns an in_use error with reference counts. ' +
        'On success, also removes learned merchant classification rules for this sub-category.',
      inputSchema: { name: z.string().min(1).describe('Sub-category name') },
    },
    async (args) => fromResult(await deleteSubCategory(deps, args.name)),
  );

  server.registerTool('list_tags', { title: 'List tags', description: 'List all tags.', inputSchema: {} }, async () =>
    json(await listTags(deps)),
  );

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description:
        'Create a tag. Tags can be attached to transactions to label them ' +
        '(e.g. "work", "travel", "reembolsável").',
      inputSchema: CreateTagSchema.shape,
    },
    async (args) => fromResult(await createTag(deps, args.name)),
  );

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description: 'Delete a tag by id. Removes the tag and all its associations with transactions.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => fromResult(await deleteTag(deps, args.id)),
  );

  server.registerTool(
    'save_dashboard',
    {
      title: 'Save dashboard',
      description:
        'Create or override a named dashboard: an HTML shell you author, stored and served live at ' +
        'GET /ui/:name (ADR-013). Upsert semantics — saving to an existing name replaces it immediately, ' +
        'no rebuild or restart needed. CRITICAL: the HTML must NEVER embed financial data, secrets, or ' +
        'tokens inline — render layout/styling only and fetch data client-side from the documented /api ' +
        'endpoints (read the fintrack://openapi resource for the contract) on page load, so the dashboard ' +
        'is always live and safe to share. Rejected (validation error) if the HTML has no <html> root or ' +
        'an inline <script> has a syntax error — fix the reported issue and save again.',
      inputSchema: SaveDashboardSchema.shape,
    },
    async (args) => fromResult(await saveDashboard(deps, args.name, args.html)),
  );

  server.registerTool(
    'list_dashboards',
    {
      title: 'List dashboards',
      description: 'List saved dashboards by name and last-updated time (HTML content omitted).',
      inputSchema: {},
    },
    async () => json(await listDashboards(deps)),
  );

  server.registerTool(
    'set_locale',
    {
      title: 'Set locale',
      description:
        'Set the display language for default categories (en/es/pt). The AI agent should call this ' +
        'when it detects the user\'s language from conversation — use source "inferred". ' +
        'When the user explicitly requests a locale change, use source "explicit". ' +
        'GUARDRAILS: (1) Anti-churn — only switch on a clear, sustained language change, not on ' +
        'isolated foreign words, merchant names, or proper nouns. (2) Respect explicit — if the ' +
        'current locale_source is "explicit", do not auto-switch with source "inferred"; the user ' +
        'must explicitly request the change. Use get_preferences to check the current locale and source.',
      inputSchema: {
        locale: Locale,
        source: LocaleSource.exclude([LocaleSource.enum.default]),
      },
    },
    async (args) => fromResult(await setLocale(deps, args)),
  );

  server.registerTool(
    'get_preferences',
    {
      title: 'Get user preferences',
      description:
        'Returns the stored locale preference and locale_source. Use this to check whether the user set the ' +
        'locale explicitly before attempting an inferred switch. Note: the FINTRACK_LOCALE env var can ' +
        'override the effective display locale used by list_categories; ' +
        'this tool reports the stored preference, not the effective override.',
      inputSchema: {},
    },
    async () => json(await getPreferences(deps)),
  );

  server.registerTool(
    'get_status',
    {
      title: 'Get server status',
      description:
        'Returns server name, version, database reachability, and active locale. ' +
        'A convenience for tool-only callers (the AI agent / chat user) — complements the ' +
        'protocol-native initialize serverInfo (version) and ping (liveness), which are not ' +
        'accessible via tools.',
      inputSchema: {},
    },
    async () => json(await getStatus(deps, version)),
  );

  return server;
};
