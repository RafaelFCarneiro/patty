import * as transactionAdapters from '../../../adapters/transactions.js';
import { confirmTransaction } from '../../../controllers/transaction/core.js';
import { searchTransactions } from '../../../controllers/transaction/read.js';
import { pageSchema } from '../../../models/page.js';
import { TransactionViewSchema } from '../../../models/transaction.js';
import * as wireInTransactions from '../../../wire/in/transactions.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, idParam, notFound404, parse, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const TRANSACTIONS_TAG = 'Transactions';

export const transactionRoutes = (): RouteDefinition[] => {
  return [
    {
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
        const { id } = req.params as { id: string };
        const wireIn = parse(wireInTransactions.ConfirmTransactionSchema, { ...(req.body ?? {}), id }, reply);
        if (!wireIn) return reply;
        const flow = () =>
          confirmTransaction(deps, transactionAdapters.confirmWireInToModel(wireIn)).map(
            transactionAdapters.outcomeToDb,
          );
        return send(reply, await runEffects(flow));
      },
    },
    {
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
        const { deps } = scope();
        const wireIn = parse(wireInTransactions.SearchTransactionsInputSchema, req.query, reply);
        if (!wireIn) return reply;
        return send(reply, await searchTransactions(deps, transactionAdapters.searchWireInToModel(wireIn)));
      },
    },
  ];
};
