import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createAccount,
  deleteAccount,
  getAccountBalances,
  listAccounts,
  updateAccount,
} from '../../../controllers/account/account.js';
import {
  addAccountExpense,
  addAccountIncome,
  deleteAccountTransaction,
  importAccountStatement,
  updateAccountTransaction,
} from '../../../controllers/account/transaction.js';
import { AccountType } from '../../../models/account.js';
import { DeleteTransactionSchema, TransactionSource, TransactionTool } from '../../../models/transaction.js';
import {
  AddAccountMovementSchema,
  CreateAccountSchema,
  ImportAccountStatementSchema,
  UpdateAccountSchema,
  UpdateAccountTransactionSchema,
} from '../../../wire/in/accounts.js';
import * as accountAdapters from '../../../adapters/accounts.js';
import {
  bulkResultToWireOut,
  createResultToWireOut,
  deleteResultToWireOut,
  outcomeToDb,
} from '../../../adapters/transactions.js';
import { buildBulkResult } from '../../../controllers/transaction/bulk.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';
import { STATEMENT_IMPORT_RESULT_DESCRIPTION } from '../shared.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

/** Shared by add_account_expense/add_account_income — identical aside from which movement kind
 *  is being recorded. */
const addAccountMovementDescription = (movement: 'expense' | 'income'): string =>
  `Record ${movement === 'expense' ? 'an expense from' : 'income into'} a bank account / wallet — the ` +
  "account aggregate's movement entry point (ADR-016). Resolves the account and category by name; " +
  'when category is omitted, classifies via learned merchant→category associations and returns method + ' +
  'confidence (confirm with the user when confidence < 0.6). Idempotent automatically — a repeat call with ' +
  'the same account/description/date/amount/currency is deduped; pass discriminator to record a genuinely ' +
  'separate transaction that would otherwise look identical. Currency comes from the account, or the ' +
  `currency field (default USD). Omitting account records an unattached ${movement === 'expense' ? '(e.g. cash) expense' : 'income'}.`;

export const registerAccountTools = (server: McpServer, ctx: McpContext): void => {
  server.registerTool(
    'add_account_expense',
    {
      annotations: MUTATING,
      title: 'Add account expense',
      description: addAccountMovementDescription('expense'),
      inputSchema: AddAccountMovementSchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const model = accountAdapters.addAccountMovementWireInToModel(args);
      const flow = () => addAccountExpense(deps, model, TransactionSource.enum.mcp).map(outcomeToDb);
      return fromResult((await runEffects(flow)).map(createResultToWireOut));
    },
  );

  server.registerTool(
    'add_account_income',
    {
      annotations: MUTATING,
      title: 'Add account income',
      description: addAccountMovementDescription('income'),
      inputSchema: AddAccountMovementSchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const model = accountAdapters.addAccountMovementWireInToModel(args);
      const flow = () => addAccountIncome(deps, model, TransactionSource.enum.mcp).map(outcomeToDb);
      return fromResult((await runEffects(flow)).map(createResultToWireOut));
    },
  );

  server.registerTool(
    'import_account_statement',
    {
      annotations: MUTATING,
      title: 'Import an account statement',
      description:
        'Import a bank/wallet statement (pasted text, CSV lines) — every item is an expense or income ' +
        "(per item's `type`) on the ONE account named at the top level (omit to record unattached, e.g. " +
        "cash, movements) — the account aggregate's bulk entry point (ADR-017) — use import_card_statement " +
        `instead for a credit-card statement. ${STATEMENT_IMPORT_RESULT_DESCRIPTION}`,
      inputSchema: ImportAccountStatementSchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffectsSequence } = ctx.as(extra);
      const model = accountAdapters.importAccountStatementWireInToModel(args);
      const plan = await importAccountStatement(deps, model, TransactionSource.enum.import);
      const outcomes = await runEffectsSequence(plan.lines, (line) => () => plan.flowFor(line)().map(outcomeToDb));
      return json(bulkResultToWireOut(buildBulkResult(outcomes, plan.lines)));
    },
  );

  server.registerTool(
    TransactionTool.updateAccountTransaction,
    {
      annotations: MUTATING,
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
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () =>
        updateAccountTransaction(deps, accountAdapters.updateAccountTransactionWireInToModel(args)).map(outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    TransactionTool.deleteAccountTransaction,
    {
      annotations: MUTATING,
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
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => deleteAccountTransaction(deps, args).map(outcomeToDb);
      return fromResult((await runEffects(flow)).map(deleteResultToWireOut));
    },
  );

  server.registerTool(
    'create_account',
    {
      annotations: MUTATING,
      title: 'Create account',
      description:
        'Create a bank account / wallet. Type defaults to checking, currency to USD. ' +
        'Note: credit accounts are created automatically with a credit card (create_credit_card).',
      inputSchema: CreateAccountSchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () =>
        createAccount(deps, accountAdapters.createWireInToModel(args)).map(accountAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'get_account_balances',
    {
      annotations: READ_ONLY,
      title: 'Get account balances',
      description:
        'Returns { balances, consolidatedNetWorth }. Each balance is derived: initialBalance + income − expenses ' +
        '+ transfers in − transfers out, plus an optional converted block (read-time valuation against the base ' +
        'currency, with rate/asOf/stale — absent when no exchange rate is on file). consolidatedNetWorth sums ' +
        'every convertible balance in the base currency; accounts with no rate are listed in its excluded array. ' +
        'Optionally filter by account name or type.',
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
    async (args, extra) => {
      const { deps } = ctx.as(extra);
      return fromResult(await getAccountBalances(deps, args));
    },
  );

  server.registerTool(
    'list_accounts',
    {
      annotations: READ_ONLY,
      title: 'List accounts',
      description: 'List accounts with their currencies, optionally filtered by type (checking = conta corrente).',
      inputSchema: {
        type: AccountType.optional(),
      },
    },
    async (args, extra) => {
      const { deps } = ctx.as(extra);
      return json(await listAccounts(deps, args.type));
    },
  );

  server.registerTool(
    'update_account',
    {
      annotations: MUTATING,
      title: 'Update account',
      description:
        'Update a bank account. name (via newName) and initialBalance are always editable. ' +
        'type is only editable when the account has no transactions/transfers (and cannot be set to credit). ' +
        'currency is only editable when the account has no transactions/transfers, ' +
        'no recurring rules, and is not a credit card payment account. ' +
        'Credit accounts (card-managed) are rejected — use the card flow.',
      inputSchema: UpdateAccountSchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () =>
        updateAccount(deps, accountAdapters.updateWireInToModel(args)).map(accountAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'delete_account',
    {
      annotations: MUTATING,
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
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => deleteAccount(deps, args.name).map(accountAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
