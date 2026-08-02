import * as transactionAdapters from '../../../adapters/transactions.js';
import { confirmTransaction } from '../../../controllers/transaction/core.js';
import { searchTransactions } from '../../../controllers/transaction/read.js';
import { pageSchema } from '../../../models/page.js';
import { TransactionViewSchema } from '../../../models/transaction.js';
import * as wireInTransactions from '../../../wire/in/transactions.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, idParam, notFound404, parse, send, validation422, RouteTag } from '../respond.js';

export const transactionRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'post',
      path: '/api/transactions/:id/confirm',
      tags: [RouteTag.transactions],
      summary: 'Confirm (clear) a pending transaction',
      request: { params: idParam, body: jsonBody(wireInTransactions.ConfirmTransactionSchema.omit({ id: true })) },
      responses: {
        200: okResponse('Transaction confirmed', TransactionViewSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
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
      path: '/api/transactions',
      tags: [RouteTag.transactions],
      summary: 'Search transactions',
      request: { query: wireInTransactions.SearchTransactionsQuerySchema },
      responses: {
        200: okResponse('A page of matching transactions', pageSchema(TransactionViewSchema)),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInTransactions.SearchTransactionsInputSchema, req.query, reply);
        if (!wireIn) return reply;
        return send(reply, await searchTransactions(deps, transactionAdapters.searchWireInToModel(wireIn)));
      },
    },
  ];
};
