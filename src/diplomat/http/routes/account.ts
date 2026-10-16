import { z } from 'zod';
import * as accountAdapters from '../../../adapters/accounts.js';
import * as transactionAdapters from '../../../adapters/transactions.js';
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
import { buildBulkResult } from '../../../controllers/transaction/bulk.js';
import { AccountBalancesResultSchema, AccountSchema } from '../../../models/account.js';
import { TransactionSource, TransactionViewSchema } from '../../../models/transaction.js';
import * as wireInAccounts from '../../../wire/in/accounts.js';
import { DeletedOut } from '../../../wire/out/common.js';
import { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../../../wire/out/transactions.js';
import { REMEDY_ROUTE } from '../remedy.js';
import { jsonBody, okResponse, type RouteDefinition, type RouteHandler } from '../openapi.js';
import {
  conflict409,
  confirmQuery,
  idParam,
  invalidQueryResponse,
  isConfirmed,
  nameParam,
  notFound404,
  parse,
  parseOrIssue,
  pathParam,
  send,
  sendUpsert,
  validation422,
} from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const ACCOUNTS_TAG = 'Accounts';
const INVALID_ACCOUNT_TYPE_ISSUE = 'invalid type';

const listAccountsRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/accounts',
  tags: [ACCOUNTS_TAG],
  summary: 'List accounts',
  request: { query: wireInAccounts.AccountsQuerySchema },
  responses: { 200: okResponse('Accounts', z.array(AccountSchema)), 422: validation422 },
  handler: async (req, reply, scope) => {
    const { deps } = scope();
    const query = parseOrIssue(wireInAccounts.AccountsQuerySchema, req.query, reply, INVALID_ACCOUNT_TYPE_ISSUE);
    if (!query) return reply;
    return reply.send(await listAccounts(deps, query.type));
  },
};

const getAccountBalancesRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/accounts/balances',
  tags: [ACCOUNTS_TAG],
  summary: 'Get account balances',
  request: { query: wireInAccounts.AccountBalancesQuerySchema },
  responses: {
    200: okResponse('Account balances + consolidated net worth', AccountBalancesResultSchema),
    404: notFound404,
    409: conflict409,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const { deps } = scope();
    const query = wireInAccounts.AccountBalancesQuerySchema.safeParse(req.query);
    if (!query.success) return invalidQueryResponse(reply);
    return send(reply, await getAccountBalances(deps, query.data));
  },
};

const createAccountRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/accounts',
  tags: [ACCOUNTS_TAG],
  summary: 'Create account',
  request: { body: jsonBody(wireInAccounts.CreateAccountSchema) },
  responses: { 201: okResponse('Account created', AccountSchema), 409: conflict409, 422: validation422 },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const wireIn = parse(wireInAccounts.CreateAccountSchema, req.body, reply);
    if (!wireIn) return reply;
    const flow = () =>
      createAccount(deps, accountAdapters.createWireInToModel(wireIn)).map(accountAdapters.outcomeToDb);
    return send(reply, await runEffects(flow), 201);
  },
};

const updateAccountRoute: RouteDefinition = {
  method: 'patch',
  scope: WRITE_SCOPE,
  path: '/api/accounts/:name',
  tags: [ACCOUNTS_TAG],
  summary: 'Update account',
  request: { params: nameParam, body: jsonBody(wireInAccounts.UpdateAccountSchema.omit({ name: true })) },
  responses: {
    200: okResponse('Account updated', AccountSchema),
    404: notFound404,
    409: conflict409,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const name = pathParam(req, 'name');
    const wireIn = parse(wireInAccounts.UpdateAccountSchema, { ...(req.body ?? {}), name }, reply);
    if (!wireIn) return reply;
    const flow = () =>
      updateAccount(deps, accountAdapters.updateWireInToModel(wireIn)).map(accountAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

const deleteAccountRoute: RouteDefinition = {
  method: 'delete',
  scope: WRITE_SCOPE,
  path: '/api/accounts/:name',
  tags: [ACCOUNTS_TAG],
  summary: 'Delete account',
  request: { params: nameParam },
  responses: {
    200: okResponse('Account deleted', DeletedOut),
    404: notFound404,
    409: conflict409,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const flow = () => deleteAccount(deps, pathParam(req, 'name')).map(accountAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

const movementResponses = (replay: string, created: string) => ({
  200: okResponse(replay, CreateTransactionOut),
  201: okResponse(created, CreateTransactionOut),
  404: notFound404,
  409: conflict409,
  422: validation422,
});

/** Shared by the expense and income routes — identical aside from which movement the controller records. */
const recordMovement =
  (record: typeof addAccountExpense): RouteHandler =>
  async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const wireIn = parse(wireInAccounts.AddAccountMovementSchema, req.body, reply);
    if (!wireIn) return reply;
    const model = accountAdapters.addAccountMovementWireInToModel(wireIn);
    const flow = () => record(deps, model, TransactionSource.enum.rest).map(transactionAdapters.outcomeToDb);
    return sendUpsert(reply, (await runEffects(flow)).map(transactionAdapters.createResultToWireOut));
  };

const addAccountExpenseRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/accounts/expenses',
  tags: [ACCOUNTS_TAG],
  summary: 'Add an account expense',
  request: { body: jsonBody(wireInAccounts.AddAccountMovementSchema) },
  responses: movementResponses('Existing expense returned (idempotent replay)', 'Expense recorded'),
  handler: recordMovement(addAccountExpense),
};

const addAccountIncomeRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/accounts/income',
  tags: [ACCOUNTS_TAG],
  summary: 'Add account income',
  request: { body: jsonBody(wireInAccounts.AddAccountMovementSchema) },
  responses: movementResponses('Existing income returned (idempotent replay)', 'Income recorded'),
  handler: recordMovement(addAccountIncome),
};

const importAccountStatementRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/accounts/statement',
  tags: [ACCOUNTS_TAG],
  summary: 'Import an account statement',
  request: { body: jsonBody(wireInAccounts.ImportAccountStatementSchema) },
  responses: { 201: okResponse('Import result', BulkResultOut), 422: validation422 },
  // Orchestration (plan → run each line → bulk result) that belongs in a controller; kept as one named step here
  // until the controllers can hand back the adapted flow (the adapters are the edge's).
  handler: async (req, reply, scope) => {
    const { deps, runEffectsSequence } = scope();
    const wireIn = parse(wireInAccounts.ImportAccountStatementSchema, req.body, reply);
    if (!wireIn) return reply;
    const plan = await importAccountStatement(
      deps,
      accountAdapters.importAccountStatementWireInToModel(wireIn),
      TransactionSource.enum.import,
    );
    const outcomes = await runEffectsSequence(
      plan.lines,
      (line) => () => plan.flowFor(line)().map(transactionAdapters.outcomeToDb),
    );
    return reply.status(201).send(transactionAdapters.bulkResultToWireOut(buildBulkResult(outcomes, plan.lines)));
  },
};

const updateAccountTransactionRoute: RouteDefinition = {
  ...REMEDY_ROUTE.update_account_transaction,
  scope: WRITE_SCOPE,
  tags: [ACCOUNTS_TAG],
  summary: 'Update an account transaction',
  request: {
    params: idParam,
    body: jsonBody(wireInAccounts.UpdateAccountTransactionSchema.omit({ id: true })),
  },
  responses: {
    200: okResponse('Transaction updated', TransactionViewSchema),
    404: notFound404,
    409: conflict409,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const id = pathParam(req, 'id');
    const wireIn = parse(wireInAccounts.UpdateAccountTransactionSchema, { ...(req.body as object), id }, reply);
    if (!wireIn) return reply;
    const model = accountAdapters.updateAccountTransactionWireInToModel(wireIn);
    const flow = () => updateAccountTransaction(deps, model).map(transactionAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

const deleteAccountTransactionRoute: RouteDefinition = {
  ...REMEDY_ROUTE.delete_account_transaction,
  scope: WRITE_SCOPE,
  tags: [ACCOUNTS_TAG],
  summary: 'Delete an account transaction',
  request: { params: idParam, query: confirmQuery },
  responses: {
    200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteTransactionOut),
    404: notFound404,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const input = { id: pathParam(req, 'id'), confirm: isConfirmed(req) };
    const flow = () => deleteAccountTransaction(deps, input).map(transactionAdapters.outcomeToDb);
    return send(reply, (await runEffects(flow)).map(transactionAdapters.deleteResultToWireOut));
  },
};

export const accountRoutes: RouteDefinition[] = [
  listAccountsRoute,
  getAccountBalancesRoute,
  createAccountRoute,
  updateAccountRoute,
  deleteAccountRoute,
  addAccountExpenseRoute,
  addAccountIncomeRoute,
  importAccountStatementRoute,
  updateAccountTransactionRoute,
  deleteAccountTransactionRoute,
];
