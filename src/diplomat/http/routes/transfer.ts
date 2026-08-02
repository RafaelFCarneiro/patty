import { httpStatus } from '../../../common/errors.js';
import * as accountAdapters from '../../../adapters/accounts.js';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { createTransfer } from '../../../controllers/account/transfer.js';
import { TransactionSource } from '../../../models/transaction.js';
import * as wireInAccounts from '../../../wire/in/accounts.js';
import { TransferResultOut } from '../../../wire/out/transactions.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, notFound404, parse, validation422 } from '../respond.js';

const TRANSFERS_TAG = 'Transfers';

export const transferRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'post',
      path: '/api/transfers',
      tags: [TRANSFERS_TAG],
      summary: 'Transfer between accounts',
      request: { body: jsonBody(wireInAccounts.CreateTransferSchema) },
      responses: {
        200: okResponse('Existing transfer returned (idempotent replay)', TransferResultOut),
        201: okResponse('Transfer created', TransferResultOut),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInAccounts.CreateTransferSchema, req.body, reply);
        if (!wireIn) return reply;
        const model = accountAdapters.transferWireInToModel(wireIn);
        const flow = () =>
          createTransfer(deps, model, TransactionSource.enum.rest).map(transactionAdapters.outcomeToDb);
        const result = await runEffects(flow);
        return result.match(
          (value) => reply.status(value.created ? 201 : 200).send(value),
          (e) => reply.status(httpStatus(e)).send({ error: e }),
        );
      },
    },
  ];
};
