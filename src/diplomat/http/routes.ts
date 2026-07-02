import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Result } from 'neverthrow';
import { z } from 'zod';
import { httpStatus, type AppError } from '../../common/errors.js';
import * as accountAdapters from '../../adapters/accounts.js';
import * as categoryAdapters from '../../adapters/categories.js';
import * as creditCardAdapters from '../../adapters/creditCards.js';
import * as recurringAdapters from '../../adapters/recurring.js';
import * as transactionAdapters from '../../adapters/transactions.js';
import {
  createAccount,
  deleteAccount,
  getAccountBalances,
  listAccounts,
  updateAccount,
} from '../../controllers/accounts.js';
import { aggregateSpending } from '../../controllers/aggregate.js';
import { getBill, payBill } from '../../controllers/bills.js';
import { getDashboard, listDashboards, saveDashboard } from '../../controllers/dashboards.js';
import {
  createCategory,
  createSubCategory,
  deleteCategory,
  deleteSubCategory,
  listCategories,
  listSubCategories,
} from '../../controllers/categories.js';
import { createCreditCard, deleteCreditCard, listCreditCards } from '../../controllers/creditCards.js';
import type { Deps } from '../../controllers/deps.js';
import { applyDueRecurring, createRecurring, listRecurring } from '../../controllers/recurring.js';
import { createTag, deleteTag, listTags } from '../../controllers/tags.js';
import { getStatus } from '../../controllers/status.js';
import { getSpendingSummary } from '../../controllers/summary.js';
import {
  confirmTransaction,
  createTransaction,
  createTransactionsBulk,
  deleteTransaction,
  searchTransactions,
  updateTransaction,
} from '../../controllers/transactions.js';
import { createTransfer } from '../../controllers/transfers.js';
import { AccountBalanceSchema, AccountSchema } from '../../models/account.js';
import { AggregateResultSchema } from '../../models/aggregate.js';
import { BillSchema } from '../../models/bill.js';
import { DashboardListItemSchema, DashboardSchema, SaveDashboardSchema } from '../../models/dashboard.js';
import { CategorySchema, SubCategorySchema } from '../../models/category.js';
import { CreditCardSchema } from '../../models/creditCard.js';
import { RecurringRuleViewSchema } from '../../models/recurring.js';
import { TagSchema } from '../../models/tag.js';
import { TransactionSource, TransactionViewSchema } from '../../models/transaction.js';
import { AggregateSpendingInputSchema } from '../../wire/in/aggregate.js';
import { CoercedPeriodSchema } from '../../wire/in/period.js';
import {
  BillQuery,
  PayBill,
  type BillQuery as BillQueryType,
  type PayBill as PayBillType,
} from '../../wire/in/bills.js';
import * as wireInAccounts from '../../wire/in/accounts.js';
import * as wireInCategories from '../../wire/in/categories.js';
import { ConfirmQuerySchema, IdParamSchema, NameParamSchema } from '../../wire/in/common.js';
import * as wireInCreditCards from '../../wire/in/creditCards.js';
import * as wireInRecurring from '../../wire/in/recurring.js';
import * as wireInTransactions from '../../wire/in/transactions.js';
import { CreateTagSchema } from '../../wire/in/tags.js';
import { BillViewOut } from '../../wire/out/bills.js';
import { DeletedOut } from '../../wire/out/common.js';
import { DeleteCreditCardResultOut } from '../../wire/out/creditCards.js';
import { ConflictErrorOut, NotFoundErrorOut, ValidationErrorOut } from '../../wire/out/errors.js';
import { ApplyDueResultOut } from '../../wire/out/recurring.js';
import { HealthOut, StatusOut } from '../../wire/out/status.js';
import { SpendingSummaryOut } from '../../wire/out/summary.js';
import {
  BulkResultOut,
  CreateTransactionOut,
  DeleteTransactionOut,
  TransferResultOut,
} from '../../wire/out/transactions.js';
import { buildOpenApiDocument, jsonBody, mountRoutes, okResponse, type RouteDefinition } from './openapi.js';

/** Thin diplomat: zod-parse (wire/in) → wireInToModel → controller → map Result to HTTP. */

// Shared by /ui/:name and /api/openapi.json — both must never be masked by a stale browser copy.
const CACHE_CONTROL_NO_CACHE = 'no-cache';

const send = <T>(reply: FastifyReply, result: Result<T, AppError>, okStatus = 200) =>
  result.match(
    (value) => reply.status(okStatus).send(value),
    (e) => reply.status(httpStatus(e)).send({ error: e }),
  );

const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.output<S> | null => {
  const r = schema.safeParse(body);
  if (!r.success) {
    reply.status(422).send({ error: { code: 'validation', issues: r.error.issues.map((i) => i.message) } });
    return null;
  }
  return r.data as z.output<S>;
};

// OpenAPI response-config shorthands, reused across the routes below — composed here (not in
// openapi.ts) because they're built from wire/out/errors.js schemas, and openapi.ts stays
// domain/wire-agnostic (routing + doc-generation mechanics only).
const validation422 = okResponse('Validation error', ValidationErrorOut);
const notFound404 = okResponse('Not found', NotFoundErrorOut);
const conflict409 = okResponse('Conflict', ConflictErrorOut);
const nameParam = NameParamSchema;
const idParam = IdParamSchema;
const confirmQuery = ConfirmQuerySchema;

// OpenAPI grouping tags — each repeats across several routes below, so named once here
// rather than copy-pasted (code-quality.md "Constants over literals").
const RouteTag = {
  system: 'System',
  accounts: 'Accounts',
  categories: 'Categories',
  transactions: 'Transactions',
  creditCards: 'CreditCards',
  bills: 'Bills',
  transfers: 'Transfers',
  recurring: 'Recurring',
  tags: 'Tags',
  aggregate: 'Aggregate',
  summary: 'Summary',
  dashboards: 'Dashboards',
} as const;

/**
 * Every REST route, declared exactly once: method, path, OpenAPI docs, and the real handler
 * together in one object. `registerRoutes` mounts this list on Fastify and documents it at
 * `/api/openapi.json`; the MCP resource `fintrack://openapi` documents the same list without
 * ever mounting it — so there is nowhere for the two surfaces to drift apart (ADR-013 Phase A).
 */
export const buildRouteDefinitions = (deps: Deps, version: string): RouteDefinition[] => [
  {
    method: 'get',
    path: '/api/health',
    tags: [RouteTag.system],
    summary: 'Liveness probe',
    responses: { 200: okResponse('OK', HealthOut) },
    handler: async () => ({ status: 'ok' }),
  },
  {
    method: 'get',
    path: '/api/status',
    tags: [RouteTag.system],
    summary: 'Server status',
    responses: { 200: okResponse('Server status', StatusOut) },
    handler: async () => getStatus(deps, version),
  },

  {
    method: 'get',
    path: '/api/accounts',
    tags: [RouteTag.accounts],
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
    tags: [RouteTag.accounts],
    summary: 'Get account balances',
    request: { query: wireInAccounts.AccountBalancesQuerySchema },
    responses: {
      200: okResponse('Account balances', z.array(AccountBalanceSchema)),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const q = wireInAccounts.AccountBalancesQuerySchema.safeParse(req.query);
      if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid query'] } });
      return send(reply, await getAccountBalances(deps, q.data));
    },
  },
  {
    method: 'post',
    path: '/api/accounts',
    tags: [RouteTag.accounts],
    summary: 'Create account',
    request: { body: jsonBody(wireInAccounts.CreateAccountSchema) },
    responses: { 201: okResponse('Account created', AccountSchema), 409: conflict409, 422: validation422 },
    handler: async (req, reply) => {
      const wireIn = parse(wireInAccounts.CreateAccountSchema, req.body, reply);
      if (!wireIn) return reply;
      return send(reply, await createAccount(deps, accountAdapters.createWireInToModel(wireIn)), 201);
    },
  },
  {
    method: 'patch',
    path: '/api/accounts/:name',
    tags: [RouteTag.accounts],
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
      return send(reply, await updateAccount(deps, accountAdapters.updateWireInToModel(wireIn)));
    },
  },
  {
    method: 'delete',
    path: '/api/accounts/:name',
    tags: [RouteTag.accounts],
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
      return send(reply, await deleteAccount(deps, name));
    },
  },

  {
    method: 'get',
    path: '/api/categories',
    tags: [RouteTag.categories],
    summary: 'List categories',
    responses: { 200: okResponse('Categories', z.array(CategorySchema)) },
    handler: async () => listCategories(deps),
  },
  {
    method: 'post',
    path: '/api/categories',
    tags: [RouteTag.categories],
    summary: 'Create category',
    request: { body: jsonBody(wireInCategories.CreateCategorySchema) },
    responses: { 201: okResponse('Category created', CategorySchema), 409: conflict409, 422: validation422 },
    handler: async (req, reply) => {
      const wireIn = parse(wireInCategories.CreateCategorySchema, req.body, reply);
      if (!wireIn) return reply;
      return send(reply, await createCategory(deps, categoryAdapters.wireInToModel(wireIn)), 201);
    },
  },
  {
    method: 'get',
    path: '/api/sub-categories',
    tags: [RouteTag.categories],
    summary: 'List sub-categories',
    request: { query: wireInCategories.SubCategoriesQuerySchema },
    responses: { 200: okResponse('Sub-categories', z.array(SubCategorySchema)), 422: validation422 },
    handler: async (req, reply) => {
      const q = wireInCategories.SubCategoriesQuerySchema.safeParse(req.query);
      if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid query'] } });
      return reply.send(await listSubCategories(deps, q.data.parentId));
    },
  },
  {
    method: 'post',
    path: '/api/sub-categories',
    tags: [RouteTag.categories],
    summary: 'Create sub-category',
    request: { body: jsonBody(wireInCategories.CreateSubCategorySchema) },
    responses: {
      201: okResponse('Sub-category created', SubCategorySchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const wireIn = parse(wireInCategories.CreateSubCategorySchema, req.body, reply);
      if (!wireIn) return reply;
      return send(reply, await createSubCategory(deps, wireIn), 201);
    },
  },
  {
    method: 'delete',
    path: '/api/categories/:name',
    tags: [RouteTag.categories],
    summary: 'Delete category',
    request: { params: nameParam },
    responses: { 200: okResponse('Category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
    handler: async (req, reply) => {
      const { name } = req.params as { name: string };
      return send(reply, await deleteCategory(deps, name));
    },
  },
  {
    method: 'delete',
    path: '/api/sub-categories/:name',
    tags: [RouteTag.categories],
    summary: 'Delete sub-category',
    request: { params: nameParam },
    responses: { 200: okResponse('Sub-category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
    handler: async (req, reply) => {
      const { name } = req.params as { name: string };
      return send(reply, await deleteSubCategory(deps, name));
    },
  },

  {
    method: 'post',
    path: '/api/transactions',
    tags: [RouteTag.transactions],
    summary: 'Create transaction',
    request: { body: jsonBody(wireInTransactions.CreateTransactionInputSchema) },
    responses: {
      200: okResponse('Existing transaction returned (idempotent replay)', CreateTransactionOut),
      201: okResponse('Transaction created', CreateTransactionOut),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const wireIn = parse(wireInTransactions.CreateTransactionInputSchema, req.body, reply);
      if (!wireIn) return reply;
      const model = transactionAdapters.createWireInToModel(wireIn);
      const result = await createTransaction(deps, model, TransactionSource.enum.rest);
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
    path: '/api/transactions/bulk',
    tags: [RouteTag.transactions],
    summary: 'Bulk-create transactions',
    request: { body: jsonBody(wireInTransactions.CreateTransactionsBulkInputSchema) },
    responses: { 201: okResponse('Bulk import result', BulkResultOut), 422: validation422 },
    handler: async (req, reply) => {
      const wireIn = parse(wireInTransactions.CreateTransactionsBulkInputSchema, req.body, reply);
      if (!wireIn) return reply;
      const model = transactionAdapters.bulkWireInToModel(wireIn);
      const result = await createTransactionsBulk(deps, model, TransactionSource.enum.import);
      return send(reply, result.map(transactionAdapters.bulkResultToWireOut), 201);
    },
  },

  {
    method: 'get',
    path: '/api/credit-cards',
    tags: [RouteTag.creditCards],
    summary: 'List credit cards',
    responses: { 200: okResponse('Credit cards', z.array(CreditCardSchema)) },
    handler: async () => listCreditCards(deps),
  },
  {
    method: 'post',
    path: '/api/credit-cards',
    tags: [RouteTag.creditCards],
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
      return send(reply, await createCreditCard(deps, creditCardAdapters.wireInToModel(wireIn)), 201);
    },
  },
  {
    method: 'delete',
    path: '/api/credit-cards/:name',
    tags: [RouteTag.creditCards],
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
      return send(reply, await deleteCreditCard(deps, { card: name, confirm }));
    },
  },

  {
    method: 'get',
    path: '/api/bills',
    tags: [RouteTag.bills],
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
    tags: [RouteTag.bills],
    summary: 'Pay a credit card bill',
    request: { body: jsonBody(PayBill) },
    responses: { 200: okResponse('Bill paid', BillSchema), 404: notFound404, 409: conflict409, 422: validation422 },
    handler: async (req, reply) => {
      const input = parse(PayBill, req.body, reply) as PayBillType;
      if (!input) return reply;
      return send(reply, await payBill(deps, { ...input, source: TransactionSource.enum.rest }));
    },
  },

  {
    method: 'post',
    path: '/api/transfers',
    tags: [RouteTag.transfers],
    summary: 'Transfer between accounts',
    request: { body: jsonBody(wireInTransactions.CreateTransferInputSchema) },
    responses: {
      200: okResponse('Existing transfer returned (idempotent replay)', TransferResultOut),
      201: okResponse('Transfer created', TransferResultOut),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const wireIn = parse(wireInTransactions.CreateTransferInputSchema, req.body, reply);
      if (!wireIn) return reply;
      const model = transactionAdapters.transferWireInToModel(wireIn);
      const result = await createTransfer(deps, model, TransactionSource.enum.rest);
      return result.match(
        (value) => reply.status(value.created ? 201 : 200).send(value),
        (e) => reply.status(httpStatus(e)).send({ error: e }),
      );
    },
  },

  {
    method: 'get',
    path: '/api/recurring',
    tags: [RouteTag.recurring],
    summary: 'List recurring rules',
    responses: { 200: okResponse('Recurring rules', z.array(RecurringRuleViewSchema)) },
    handler: async () => listRecurring(deps),
  },
  {
    method: 'post',
    path: '/api/recurring',
    tags: [RouteTag.recurring],
    summary: 'Create recurring rule',
    request: { body: jsonBody(wireInRecurring.CreateRecurringSchema) },
    responses: {
      201: okResponse('Recurring rule created', RecurringRuleViewSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const wireIn = parse(wireInRecurring.CreateRecurringSchema, req.body, reply);
      if (!wireIn) return reply;
      return send(reply, await createRecurring(deps, recurringAdapters.wireInToModel(wireIn)), 201);
    },
  },
  {
    method: 'post',
    path: '/api/recurring/apply-due',
    tags: [RouteTag.recurring],
    summary: 'Materialize due recurring rules',
    request: { body: jsonBody(wireInRecurring.ApplyDueBodySchema) },
    responses: { 200: okResponse('Applied recurring rules', ApplyDueResultOut), 422: validation422 },
    handler: async (req, reply) => {
      const q = wireInRecurring.ApplyDueBodySchema.safeParse(req.body ?? {});
      if (!q.success)
        return reply.status(422).send({ error: { code: 'validation', issues: ['invalid through date'] } });
      return reply.send(await applyDueRecurring(deps, q.data));
    },
  },

  {
    method: 'patch',
    path: '/api/transactions/:id',
    tags: [RouteTag.transactions],
    summary: 'Update transaction',
    request: { params: idParam, body: jsonBody(wireInTransactions.UpdateTransactionInputSchema.omit({ id: true })) },
    responses: {
      200: okResponse('Transaction updated', TransactionViewSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const wireIn = parse(wireInTransactions.UpdateTransactionInputSchema, { ...(req.body as object), id }, reply);
      if (!wireIn) return reply;
      return send(reply, await updateTransaction(deps, transactionAdapters.updateWireInToModel(wireIn)));
    },
  },
  {
    method: 'post',
    path: '/api/transactions/:id/confirm',
    tags: [RouteTag.transactions],
    summary: 'Confirm (clear) a pending transaction',
    request: { params: idParam },
    responses: { 200: okResponse('Transaction confirmed', TransactionViewSchema), 404: notFound404 },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      return send(reply, await confirmTransaction(deps, { id }));
    },
  },
  {
    method: 'delete',
    path: '/api/transactions/:id',
    tags: [RouteTag.transactions],
    summary: 'Delete transaction',
    request: { params: idParam, query: confirmQuery },
    responses: {
      200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteTransactionOut),
      404: notFound404,
    },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const confirm = (req.query as { confirm?: string }).confirm === 'true';
      return send(
        reply,
        (await deleteTransaction(deps, { id, confirm })).map(transactionAdapters.deleteResultToWireOut),
      );
    },
  },
  {
    method: 'get',
    path: '/api/transactions',
    tags: [RouteTag.transactions],
    summary: 'Search transactions',
    request: { query: wireInTransactions.SearchTransactionsQuerySchema },
    responses: {
      200: okResponse('Matching transactions', z.array(TransactionViewSchema)),
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

  {
    method: 'get',
    path: '/api/tags',
    tags: [RouteTag.tags],
    summary: 'List tags',
    responses: { 200: okResponse('Tags', z.array(TagSchema)) },
    handler: async () => listTags(deps),
  },
  {
    method: 'post',
    path: '/api/tags',
    tags: [RouteTag.tags],
    summary: 'Create tag',
    request: { body: jsonBody(CreateTagSchema) },
    responses: { 201: okResponse('Tag created', TagSchema), 409: conflict409, 422: validation422 },
    handler: async (req, reply) => {
      const input = parse(CreateTagSchema, req.body, reply);
      if (!input) return reply;
      return send(reply, await createTag(deps, input.name), 201);
    },
  },
  {
    method: 'delete',
    path: '/api/tags/:id',
    tags: [RouteTag.tags],
    summary: 'Delete tag',
    request: { params: idParam },
    responses: { 200: okResponse('Tag deleted', DeletedOut) },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      return send(reply, await deleteTag(deps, id));
    },
  },

  {
    method: 'get',
    path: '/api/dashboards',
    tags: [RouteTag.dashboards],
    summary: 'List dashboards',
    responses: { 200: okResponse('Dashboards (HTML omitted)', z.array(DashboardListItemSchema)) },
    handler: async () => listDashboards(deps),
  },
  {
    method: 'get',
    path: '/api/dashboards/:name',
    tags: [RouteTag.dashboards],
    summary: 'Get a dashboard as JSON',
    request: { params: nameParam },
    responses: { 200: okResponse('Dashboard', DashboardSchema), 404: notFound404 },
    handler: async (req, reply) => {
      const { name } = req.params as { name: string };
      return send(reply, await getDashboard(deps, name));
    },
  },
  {
    method: 'post',
    path: '/api/dashboards',
    tags: [RouteTag.dashboards],
    summary: 'Save (upsert) a dashboard',
    request: { body: jsonBody(SaveDashboardSchema) },
    responses: { 200: okResponse('Dashboard saved', DashboardSchema), 422: validation422 },
    handler: async (req, reply) => {
      const wireIn = parse(SaveDashboardSchema, req.body, reply);
      if (!wireIn) return reply;
      return reply.send(await saveDashboard(deps, wireIn.name, wireIn.html));
    },
  },

  {
    method: 'get',
    path: '/api/aggregate',
    tags: [RouteTag.aggregate],
    summary: 'Aggregate spending',
    request: { query: AggregateSpendingInputSchema },
    responses: {
      200: okResponse('Aggregated spending', AggregateResultSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
    handler: async (req, reply) => {
      const wireIn = parse(AggregateSpendingInputSchema, req.query, reply);
      if (!wireIn) return reply;
      return send(reply, await aggregateSpending(deps, wireIn));
    },
  },

  {
    method: 'get',
    path: '/api/summary',
    tags: [RouteTag.summary],
    summary: 'Get spending summary',
    request: { query: CoercedPeriodSchema },
    responses: { 200: okResponse('Spending summary', SpendingSummaryOut), 422: validation422 },
    handler: async (req, reply) => {
      const input = parse(CoercedPeriodSchema, req.query, reply);
      if (!input) return reply;
      return reply.send(await getSpendingSummary(deps, input));
    },
  },
];

export const registerRoutes = (app: FastifyInstance, deps: Deps, version: string): void => {
  const definitions = buildRouteDefinitions(deps, version);
  mountRoutes(app, definitions);

  // Browser-facing HTML surface (ADR-013 Phase A item 2), not a JSON API contract — kept out of
  // the /api OpenAPI document (which documents fetch() shapes for agent-generated dashboards,
  // see docs/architecture.md § OpenAPI contract) rather than added as a text/html response there.
  app.get('/ui/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = await getDashboard(deps, name);
    return result.match(
      (dashboard) =>
        reply.header('cache-control', CACHE_CONTROL_NO_CACHE).type('text/html; charset=utf-8').send(dashboard.html),
      (e) => reply.status(httpStatus(e)).send({ error: e }),
    );
  });

  // Built from the same list just mounted; excluded from its own document by design.
  const openApiDocument = buildOpenApiDocument(definitions, version);
  app.get('/api/openapi.json', async (_req, reply) =>
    reply.header('cache-control', CACHE_CONTROL_NO_CACHE).send(openApiDocument),
  );
};
