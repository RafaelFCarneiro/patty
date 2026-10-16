import * as transactionAdapters from '../../../adapters/transactions.js';
import { confirmTransaction } from '../../../controllers/transaction/core.js';
import { searchTransactions } from '../../../controllers/transaction/read.js';
import { pageSchema } from '../../../models/page.js';
import { TransactionViewSchema } from '../../../models/transaction.js';
import * as wireInTransactions from '../../../wire/in/transactions.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, idParam, notFound404, parse, pathParam, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const TRANSACTIONS_TAG = 'Transactions';

const confirmTransactionRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/transactions/:id/confirm',
  tags: [TRANSACTIONS_TAG],
  summary: 'Confirm (clear) a pending transaction',
  request: { params: idParam, body: jsonBody(wireInTransactions.ConfirmTransactionSchema.omit({ id: true })) },
  responses: {
    200: okResponse('Transaction confirmed', TransactionViewSchema),
    404: notFound404,
    409: conflict409,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const id = pathParam(req, 'id');
    const wireIn = parse(wireInTransactions.ConfirmTransactionSchema, { ...(req.body ?? {}), id }, reply);
    if (!wireIn) return reply;
    const model = transactionAdapters.confirmWireInToModel(wireIn);
    const flow = () => confirmTransaction(deps, model).map(transactionAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

const searchTransactionsRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/transactions',
  tags: [TRANSACTIONS_TAG],
  summary: 'Search transactions',
  request: { query: wireInTransactions.SearchTransactionsQuerySchema },
  responses: {
    200: okResponse('A page of matching transactions', pageSchema(TransactionViewSchema)),
    404: notFound404,
    409: conflict409,
    422: validation422,
  },
  handler: async (req, reply, scope) => {
    const wireIn = parse(wireInTransactions.SearchTransactionsInputSchema, req.query, reply);
    if (!wireIn) return reply;
    return send(reply, await searchTransactions(scope().deps, transactionAdapters.searchWireInToModel(wireIn)));
  },
};

export const transactionRoutes: RouteDefinition[] = [confirmTransactionRoute, searchTransactionsRoute];
