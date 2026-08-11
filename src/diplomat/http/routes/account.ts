import { z } from 'zod';
import { httpStatus } from '../../../common/errors.js';
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
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import {
  conflict409,
  confirmQuery,
  idParam,
  invalidQueryResponse,
  nameParam,
  notFound404,
  parse,
  send,
  validation422,
} from '../respond.js';

const ACCOUNTS_TAG = 'Accounts';

export const accountRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects, runEffectsSequence } = ctx;
  return [
    {
      method: 'get',
      path: '/api/accounts',
      tags: [ACCOUNTS_TAG],
      summary: 'List accounts',
      request: { query: wireInAccounts.AccountsQuerySchema },
      responses: { 200: okResponse('Accounts', z.array(AccountSchema)), 422: validation422 },
      handler: async (req, reply) => {
        const q = wireInAccounts.AccountsQuerySchema.safeParse(req.query);
        if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid type'] } });
        return reply.send(await listAccounts(deps, q.data.type));
      },
    },
    {
      method: 'get',
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
      handler: async (req, reply) => {
        const q = wireInAccounts.AccountBalancesQuerySchema.safeParse(req.query);
        if (!q.success) return invalidQueryResponse(reply);
        return send(reply, await getAccountBalances(deps, q.data));
      },
    },
    {
      method: 'post',
      path: '/api/accounts',
      tags: [ACCOUNTS_TAG],
      summary: 'Create account',
      request: { body: jsonBody(wireInAccounts.CreateAccountSchema) },
      responses: { 201: okResponse('Account created', AccountSchema), 409: conflict409, 422: validation422 },
      handler: async (req, reply) => {
        const wireIn = parse(wireInAccounts.CreateAccountSchema, req.body, reply);
        if (!wireIn) return reply;
        const flow = () =>
          createAccount(deps, accountAdapters.createWireInToModel(wireIn)).map(accountAdapters.outcomeToDb);
        return send(reply, await runEffects(flow), 201);
      },
    },
    {
      method: 'patch',
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
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const wireIn = parse(wireInAccounts.UpdateAccountSchema, { ...(req.body ?? {}), name }, reply);
        if (!wireIn) return reply;
        const flow = () =>
          updateAccount(deps, accountAdapters.updateWireInToModel(wireIn)).map(accountAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'delete',
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
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const flow = () => deleteAccount(deps, name).map(accountAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'post',
      path: '/api/accounts/expenses',
      tags: [ACCOUNTS_TAG],
      summary: 'Add an account expense',
      request: { body: jsonBody(wireInAccounts.AddAccountMovementSchema) },
      responses: {
        200: okResponse('Existing expense returned (idempotent replay)', CreateTransactionOut),
        201: okResponse('Expense recorded', CreateTransactionOut),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInAccounts.AddAccountMovementSchema, req.body, reply);
        if (!wireIn) return reply;
        const model = accountAdapters.addAccountMovementWireInToModel(wireIn);
        const flow = () =>
          addAccountExpense(deps, model, TransactionSource.enum.rest).map(transactionAdapters.outcomeToDb);
        const result = await runEffects(flow);
        return result.match(
          (value) => {
            const out = transactionAdapters.createResultToWireOut(value);
            return reply.status(out.created ? 201 : 200).send(out);
          },
          (e) => reply.status(httpStatus(e)).send({ error: e }),
        );
      },
    },
    {
      method: 'post',
      path: '/api/accounts/income',
      tags: [ACCOUNTS_TAG],
      summary: 'Add account income',
      request: { body: jsonBody(wireInAccounts.AddAccountMovementSchema) },
      responses: {
        200: okResponse('Existing income returned (idempotent replay)', CreateTransactionOut),
        201: okResponse('Income recorded', CreateTransactionOut),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInAccounts.AddAccountMovementSchema, req.body, reply);
        if (!wireIn) return reply;
        const model = accountAdapters.addAccountMovementWireInToModel(wireIn);
        const flow = () =>
          addAccountIncome(deps, model, TransactionSource.enum.rest).map(transactionAdapters.outcomeToDb);
        const result = await runEffects(flow);
        return result.match(
          (value) => {
            const out = transactionAdapters.createResultToWireOut(value);
            return reply.status(out.created ? 201 : 200).send(out);
          },
          (e) => reply.status(httpStatus(e)).send({ error: e }),
        );
      },
    },
    {
      method: 'post',
      path: '/api/accounts/statement',
      tags: [ACCOUNTS_TAG],
      summary: 'Import an account statement',
      request: { body: jsonBody(wireInAccounts.ImportAccountStatementSchema) },
      responses: { 201: okResponse('Import result', BulkResultOut), 422: validation422 },
      handler: async (req, reply) => {
        const wireIn = parse(wireInAccounts.ImportAccountStatementSchema, req.body, reply);
        if (!wireIn) return reply;
        const model = accountAdapters.importAccountStatementWireInToModel(wireIn);
        const plan = importAccountStatement(deps, model, TransactionSource.enum.import);
        const outcomes = await runEffectsSequence(
          plan.lines,
          (line) => () => plan.flowFor(line)().map(transactionAdapters.outcomeToDb),
        );
        const result = buildBulkResult(outcomes, plan.lines);
        return reply.status(201).send(transactionAdapters.bulkResultToWireOut(result));
      },
    },
    {
      method: 'patch',
      path: '/api/accounts/transactions/:id',
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
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const wireIn = parse(wireInAccounts.UpdateAccountTransactionSchema, { ...(req.body as object), id }, reply);
        if (!wireIn) return reply;
        const flow = () =>
          updateAccountTransaction(deps, accountAdapters.updateAccountTransactionWireInToModel(wireIn)).map(
            transactionAdapters.outcomeToDb,
          );
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'delete',
      path: '/api/accounts/transactions/:id',
      tags: [ACCOUNTS_TAG],
      summary: 'Delete an account transaction',
      request: { params: idParam, query: confirmQuery },
      responses: {
        200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteTransactionOut),
        404: notFound404,
        422: validation422,
      },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const confirm = (req.query as { confirm?: string }).confirm === 'true';
        const flow = () => deleteAccountTransaction(deps, { id, confirm }).map(transactionAdapters.outcomeToDb);
        const result = (await runEffects(flow)).map(transactionAdapters.deleteResultToWireOut);
        return send(reply, result);
      },
    },
  ];
};
