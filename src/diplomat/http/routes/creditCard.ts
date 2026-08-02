import { z } from 'zod';
import { httpStatus } from '../../../common/errors.js';
import * as accountAdapters from '../../../adapters/accounts.js';
import * as billAdapters from '../../../adapters/bills.js';
import * as creditCardAdapters from '../../../adapters/creditCards.js';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { getBill, payBill, revertBillPayment } from '../../../controllers/creditCard/bill.js';
import {
  createCreditCard,
  deleteCreditCard,
  listCreditCards,
  updateCreditCard,
} from '../../../controllers/creditCard/creditCard.js';
import {
  addCardPurchase,
  deleteCardTransaction,
  importCardStatement,
  updateCardTransaction,
} from '../../../controllers/creditCard/transaction.js';
import { buildBulkResult } from '../../../controllers/transaction/bulk.js';
import { BillSchema } from '../../../models/bill.js';
import { CreditCardSchema } from '../../../models/creditCard.js';
import { TransactionSource, TransactionViewSchema } from '../../../models/transaction.js';
import {
  BillQuery,
  PayBill,
  type BillQuery as BillQueryType,
  type PayBill as PayBillType,
} from '../../../wire/in/bills.js';
import * as wireInCreditCards from '../../../wire/in/creditCards.js';
import { BillViewOut } from '../../../wire/out/bills.js';
import { DeleteCreditCardResultOut } from '../../../wire/out/creditCards.js';
import { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../../../wire/out/transactions.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, confirmQuery, idParam, nameParam, notFound404, parse, send, validation422 } from '../respond.js';

const CREDIT_CARDS_TAG = 'CreditCards';
const BILLS_TAG = 'Bills';

export const creditCardRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects, runEffectsSequence } = ctx;
  return [
    {
      method: 'post',
      path: '/api/credit-cards/purchases',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Add a credit-card purchase',
      request: { body: jsonBody(wireInCreditCards.AddCardPurchaseSchema) },
      responses: {
        200: okResponse('Existing purchase returned (idempotent replay)', CreateTransactionOut),
        201: okResponse('Purchase recorded', CreateTransactionOut),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInCreditCards.AddCardPurchaseSchema, req.body, reply);
        if (!wireIn) return reply;
        const model = creditCardAdapters.addCardPurchaseWireInToModel(wireIn);
        const flow = () =>
          addCardPurchase(deps, model, TransactionSource.enum.rest)
            .map(billAdapters.outcomeToDb)
            .map(transactionAdapters.outcomeToDb);
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
      path: '/api/credit-cards/statement',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Import a credit-card statement',
      request: { body: jsonBody(wireInCreditCards.ImportCardStatementSchema) },
      responses: { 201: okResponse('Import result', BulkResultOut), 422: validation422 },
      handler: async (req, reply) => {
        const wireIn = parse(wireInCreditCards.ImportCardStatementSchema, req.body, reply);
        if (!wireIn) return reply;
        const model = creditCardAdapters.importCardStatementWireInToModel(wireIn);
        const plan = importCardStatement(deps, model, TransactionSource.enum.import);
        const outcomes = await runEffectsSequence(
          plan.lines,
          (line) => () => plan.flowFor(line)().map(billAdapters.outcomeToDb).map(transactionAdapters.outcomeToDb),
        );
        const result = buildBulkResult(outcomes, plan.lines);
        return reply.status(201).send(transactionAdapters.bulkResultToWireOut(result));
      },
    },
    {
      method: 'get',
      path: '/api/credit-cards',
      tags: [CREDIT_CARDS_TAG],
      summary: 'List credit cards',
      responses: { 200: okResponse('Credit cards', z.array(CreditCardSchema)) },
      handler: async () => listCreditCards(deps),
    },
    {
      method: 'post',
      path: '/api/credit-cards',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Create credit card',
      request: { body: jsonBody(wireInCreditCards.CreateCreditCardSchema) },
      responses: {
        201: okResponse('Credit card created', CreditCardSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInCreditCards.CreateCreditCardSchema, req.body, reply);
        if (!wireIn) return reply;
        const flow = () =>
          createCreditCard(deps, creditCardAdapters.wireInToModel(wireIn))
            .map(accountAdapters.outcomeToDb)
            .map(creditCardAdapters.outcomeToDb);
        return send(reply, await runEffects(flow), 201);
      },
    },
    {
      method: 'patch',
      path: '/api/credit-cards/:name',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Update credit card',
      request: { params: nameParam, body: jsonBody(wireInCreditCards.UpdateCreditCardSchema.omit({ name: true })) },
      responses: {
        200: okResponse('Credit card updated', CreditCardSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const wireIn = parse(wireInCreditCards.UpdateCreditCardSchema, { ...(req.body ?? {}), name }, reply);
        if (!wireIn) return reply;
        const flow = () =>
          updateCreditCard(deps, creditCardAdapters.updateWireInToModel(wireIn))
            .map(accountAdapters.outcomeToDb)
            .map(creditCardAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'delete',
      path: '/api/credit-cards/:name',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Delete credit card',
      request: { params: nameParam, query: confirmQuery },
      responses: {
        200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteCreditCardResultOut),
        404: notFound404,
        409: conflict409,
      },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const confirm = (req.query as { confirm?: string }).confirm === 'true';
        const flow = () =>
          deleteCreditCard(deps, { card: name, confirm })
            .map(creditCardAdapters.outcomeToDb)
            .map(accountAdapters.outcomeToDb)
            .map(billAdapters.outcomeToDb)
            .map(transactionAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'get',
      path: '/api/bills',
      tags: [BILLS_TAG],
      summary: 'Get a credit card bill (fatura)',
      request: { query: BillQuery },
      responses: {
        200: okResponse('Bill with items', BillViewOut),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const input = parse(BillQuery, req.query, reply) as BillQueryType;
        if (!input) return reply;
        return send(reply, await getBill(deps, input));
      },
    },
    {
      method: 'post',
      path: '/api/bills/pay',
      tags: [BILLS_TAG],
      summary: 'Pay a credit card bill',
      request: { body: jsonBody(PayBill) },
      responses: { 200: okResponse('Bill paid', BillSchema), 404: notFound404, 409: conflict409, 422: validation422 },
      handler: async (req, reply) => {
        const input = parse(PayBill, req.body, reply) as PayBillType;
        if (!input) return reply;
        const flow = () =>
          payBill(deps, { ...input, source: TransactionSource.enum.rest })
            .map(billAdapters.outcomeToDb)
            .map(transactionAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'post',
      path: '/api/bills/revert',
      tags: [BILLS_TAG],
      summary: 'Revert a credit card bill payment',
      request: { body: jsonBody(BillQuery) },
      responses: {
        200: okResponse('Bill payment reverted (or no-op if not paid)', BillSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const input = parse(BillQuery, req.body, reply) as BillQueryType;
        if (!input) return reply;
        const flow = () =>
          revertBillPayment(deps, input).map(billAdapters.outcomeToDb).map(transactionAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'patch',
      path: '/api/credit-cards/transactions/:id',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Update a credit-card transaction',
      request: {
        params: idParam,
        body: jsonBody(wireInCreditCards.UpdateCardTransactionSchema.omit({ id: true })),
      },
      responses: {
        200: okResponse('Transaction updated', TransactionViewSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const wireIn = parse(wireInCreditCards.UpdateCardTransactionSchema, { ...(req.body as object), id }, reply);
        if (!wireIn) return reply;
        const model = creditCardAdapters.updateCardTransactionWireInToModel(wireIn);
        const flow = () =>
          updateCardTransaction(deps, model).map(billAdapters.outcomeToDb).map(transactionAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'delete',
      path: '/api/credit-cards/transactions/:id',
      tags: [CREDIT_CARDS_TAG],
      summary: 'Delete a credit-card transaction',
      request: { params: idParam, query: confirmQuery },
      responses: {
        200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteTransactionOut),
        404: notFound404,
        422: validation422,
      },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const confirm = (req.query as { confirm?: string }).confirm === 'true';
        const flow = () =>
          deleteCardTransaction(deps, { id, confirm })
            .map(billAdapters.outcomeToDb)
            .map(transactionAdapters.outcomeToDb);
        const result = (await runEffects(flow)).map(transactionAdapters.deleteResultToWireOut);
        return send(reply, result);
      },
    },
  ];
};
