import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas30';
import { z } from 'zod';
import { AccountBalanceSchema, AccountSchema } from '../../models/account.js';
import { AggregateResultSchema } from '../../models/aggregate.js';
import { BillSchema } from '../../models/bill.js';
import { CategorySchema, SubCategorySchema } from '../../models/category.js';
import { CreditCardSchema } from '../../models/creditCard.js';
import { RecurringRuleViewSchema } from '../../models/recurring.js';
import { TagSchema } from '../../models/tag.js';
import { RawTransactionViewSchema, TransactionViewSchema } from '../../models/transaction.js';
import { AggregateSpendingInputSchema } from '../../wire/in/aggregate.js';
import { BillQuery, PayBill } from '../../wire/in/bills.js';
import { CoercedPeriodSchema } from '../../wire/in/period.js';
import { CreateTagSchema } from '../../wire/in/tags.js';
import * as wireInAccounts from '../../wire/in/accounts.js';
import * as wireInCategories from '../../wire/in/categories.js';
import * as wireInCreditCards from '../../wire/in/creditCards.js';
import * as wireInRecurring from '../../wire/in/recurring.js';
import * as wireInTransactions from '../../wire/in/transactions.js';
import { StatusOut } from '../../wire/out/status.js';
import { SpendingSummaryOut } from '../../wire/out/summary.js';
import { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../../wire/out/transactions.js';

/**
 * Derives the OpenAPI 3.0 document straight from the wire/in + wire/out + models zod schemas
 * that routes.ts already uses to validate requests — no hand-authored paths that can drift.
 * The route list below mirrors routes.ts route-for-route (kept in parity by an integration test).
 */

extendZodWithOpenApi(z);

// Response shapes with no dedicated wire/out or model schema (plain controller result types).
// These document the actual response body but, unlike request schemas, are not zod-validated
// at runtime — routes.ts never parses its own outbound payloads.
const HealthOut = z.object({ status: z.literal('ok') });
const DeletedOut = z.object({ deleted: z.boolean() });
const TransferResultOut = z.object({ transaction: TransactionViewSchema, created: z.boolean() });
const BillViewOut = z.object({
  bill: BillSchema,
  cardName: z.string(),
  transactions: z.array(RawTransactionViewSchema),
  total: z.number(),
});
const ApplyDueResultOut = z.object({
  applied: z.array(z.object({ rule: z.string(), date: z.string(), transaction: TransactionViewSchema })),
  count: z.number().int(),
});
const DeleteCreditCardResultOut = z.union([
  z.object({ deleted: z.literal(true), card: z.string() }),
  z.object({
    deleted: z.literal(false),
    dryRun: z.literal(true),
    wouldDelete: z.object({
      card: z.string(),
      account: z.string(),
      transactions: z.number().int(),
      bills: z.number().int(),
    }),
    hint: z.string(),
  }),
]);

// Shared `{ error }` envelopes mirroring common/errors.ts httpStatus's exhaustive mapping —
// every AppError code resolves to exactly one of 404 / 409 / 422.
const ValidationErrorBody = z.object({
  error: z.object({ code: z.literal('validation'), issues: z.array(z.string()) }),
});
const NotFoundErrorBody = z.object({
  error: z.object({ code: z.string(), query: z.string(), candidates: z.array(z.string()) }).catchall(z.unknown()),
});
const ConflictErrorBody = z.object({
  error: z.object({ code: z.string(), entity: z.string(), name: z.string() }).catchall(z.unknown()),
});

const jsonContent = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
const okResponse = (description: string, schema: z.ZodTypeAny) => ({ description, content: jsonContent(schema) });

const validation422 = okResponse('Validation error', ValidationErrorBody);
const notFound404 = okResponse('Not found', NotFoundErrorBody);
const conflict409 = okResponse('Conflict', ConflictErrorBody);

const jsonBody = (schema: z.ZodTypeAny) => ({ content: jsonContent(schema) });

// Path params: raw route-param casts in routes.ts have no zod schema of their own to derive
// from (they are plain `req.params as {...}`), so these are documented directly.
const nameParam = z.object({ name: z.string().min(1) });
const idParam = z.object({ id: z.string().min(1) });
const confirmQuery = z.object({
  confirm: z
    .enum(['true', 'false'])
    .optional()
    .describe('Pass "true" to actually perform the action (dry-run otherwise)'),
});

const routes: RouteConfig[] = [
  {
    method: 'get',
    path: '/api/health',
    tags: ['System'],
    summary: 'Liveness probe',
    responses: { 200: okResponse('OK', HealthOut) },
  },
  {
    method: 'get',
    path: '/api/status',
    tags: ['System'],
    summary: 'Server status',
    responses: { 200: okResponse('Server status', StatusOut) },
  },

  {
    method: 'get',
    path: '/api/accounts',
    tags: ['Accounts'],
    summary: 'List accounts',
    request: { query: wireInAccounts.AccountsQuerySchema },
    responses: { 200: okResponse('Accounts', z.array(AccountSchema)), 422: validation422 },
  },
  {
    method: 'get',
    path: '/api/accounts/balances',
    tags: ['Accounts'],
    summary: 'Get account balances',
    request: { query: wireInAccounts.AccountBalancesQuerySchema },
    responses: {
      200: okResponse('Account balances', z.array(AccountBalanceSchema)),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'post',
    path: '/api/accounts',
    tags: ['Accounts'],
    summary: 'Create account',
    request: { body: jsonBody(wireInAccounts.CreateAccountSchema) },
    responses: { 201: okResponse('Account created', AccountSchema), 409: conflict409, 422: validation422 },
  },
  {
    method: 'patch',
    path: '/api/accounts/{name}',
    tags: ['Accounts'],
    summary: 'Update account',
    request: { params: nameParam, body: jsonBody(wireInAccounts.UpdateAccountSchema.omit({ name: true })) },
    responses: {
      200: okResponse('Account updated', AccountSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'delete',
    path: '/api/accounts/{name}',
    tags: ['Accounts'],
    summary: 'Delete account',
    request: { params: nameParam },
    responses: {
      200: okResponse('Account deleted', DeletedOut),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },

  {
    method: 'get',
    path: '/api/categories',
    tags: ['Categories'],
    summary: 'List categories',
    responses: { 200: okResponse('Categories', z.array(CategorySchema)) },
  },
  {
    method: 'post',
    path: '/api/categories',
    tags: ['Categories'],
    summary: 'Create category',
    request: { body: jsonBody(wireInCategories.CreateCategorySchema) },
    responses: { 201: okResponse('Category created', CategorySchema), 409: conflict409, 422: validation422 },
  },
  {
    method: 'get',
    path: '/api/sub-categories',
    tags: ['Categories'],
    summary: 'List sub-categories',
    request: { query: wireInCategories.SubCategoriesQuerySchema },
    responses: { 200: okResponse('Sub-categories', z.array(SubCategorySchema)), 422: validation422 },
  },
  {
    method: 'post',
    path: '/api/sub-categories',
    tags: ['Categories'],
    summary: 'Create sub-category',
    request: { body: jsonBody(wireInCategories.CreateSubCategorySchema) },
    responses: {
      201: okResponse('Sub-category created', SubCategorySchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'delete',
    path: '/api/categories/{name}',
    tags: ['Categories'],
    summary: 'Delete category',
    request: { params: nameParam },
    responses: { 200: okResponse('Category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
  },
  {
    method: 'delete',
    path: '/api/sub-categories/{name}',
    tags: ['Categories'],
    summary: 'Delete sub-category',
    request: { params: nameParam },
    responses: { 200: okResponse('Sub-category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
  },

  {
    method: 'post',
    path: '/api/transactions',
    tags: ['Transactions'],
    summary: 'Create transaction',
    request: { body: jsonBody(wireInTransactions.CreateTransactionInputSchema) },
    responses: {
      200: okResponse('Existing transaction returned (idempotent replay)', CreateTransactionOut),
      201: okResponse('Transaction created', CreateTransactionOut),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'post',
    path: '/api/transactions/bulk',
    tags: ['Transactions'],
    summary: 'Bulk-create transactions',
    request: { body: jsonBody(wireInTransactions.CreateTransactionsBulkInputSchema) },
    responses: { 201: okResponse('Bulk import result', BulkResultOut), 422: validation422 },
  },

  {
    method: 'get',
    path: '/api/credit-cards',
    tags: ['CreditCards'],
    summary: 'List credit cards',
    responses: { 200: okResponse('Credit cards', z.array(CreditCardSchema)) },
  },
  {
    method: 'post',
    path: '/api/credit-cards',
    tags: ['CreditCards'],
    summary: 'Create credit card',
    request: { body: jsonBody(wireInCreditCards.CreateCreditCardSchema) },
    responses: {
      201: okResponse('Credit card created', CreditCardSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'delete',
    path: '/api/credit-cards/{name}',
    tags: ['CreditCards'],
    summary: 'Delete credit card',
    request: { params: nameParam, query: confirmQuery },
    responses: {
      200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteCreditCardResultOut),
      404: notFound404,
      409: conflict409,
    },
  },

  {
    method: 'get',
    path: '/api/bills',
    tags: ['Bills'],
    summary: 'Get a credit card bill (fatura)',
    request: { query: BillQuery },
    responses: {
      200: okResponse('Bill with items', BillViewOut),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'post',
    path: '/api/bills/pay',
    tags: ['Bills'],
    summary: 'Pay a credit card bill',
    request: { body: jsonBody(PayBill) },
    responses: { 200: okResponse('Bill paid', BillSchema), 404: notFound404, 409: conflict409, 422: validation422 },
  },

  {
    method: 'post',
    path: '/api/transfers',
    tags: ['Transfers'],
    summary: 'Transfer between accounts',
    request: { body: jsonBody(wireInTransactions.CreateTransferInputSchema) },
    responses: {
      200: okResponse('Existing transfer returned (idempotent replay)', TransferResultOut),
      201: okResponse('Transfer created', TransferResultOut),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },

  {
    method: 'get',
    path: '/api/recurring',
    tags: ['Recurring'],
    summary: 'List recurring rules',
    responses: { 200: okResponse('Recurring rules', z.array(RecurringRuleViewSchema)) },
  },
  {
    method: 'post',
    path: '/api/recurring',
    tags: ['Recurring'],
    summary: 'Create recurring rule',
    request: { body: jsonBody(wireInRecurring.CreateRecurringSchema) },
    responses: {
      201: okResponse('Recurring rule created', RecurringRuleViewSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'post',
    path: '/api/recurring/apply-due',
    tags: ['Recurring'],
    summary: 'Materialize due recurring rules',
    request: { body: jsonBody(wireInRecurring.ApplyDueBodySchema) },
    responses: { 200: okResponse('Applied recurring rules', ApplyDueResultOut), 422: validation422 },
  },

  {
    method: 'patch',
    path: '/api/transactions/{id}',
    tags: ['Transactions'],
    summary: 'Update transaction',
    request: { params: idParam, body: jsonBody(wireInTransactions.UpdateTransactionInputSchema.omit({ id: true })) },
    responses: {
      200: okResponse('Transaction updated', TransactionViewSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },
  {
    method: 'post',
    path: '/api/transactions/{id}/confirm',
    tags: ['Transactions'],
    summary: 'Confirm (clear) a pending transaction',
    request: { params: idParam },
    responses: { 200: okResponse('Transaction confirmed', TransactionViewSchema), 404: notFound404 },
  },
  {
    method: 'delete',
    path: '/api/transactions/{id}',
    tags: ['Transactions'],
    summary: 'Delete transaction',
    request: { params: idParam, query: confirmQuery },
    responses: {
      200: okResponse('Deleted, or dry-run preview when confirm is omitted', DeleteTransactionOut),
      404: notFound404,
    },
  },
  {
    method: 'get',
    path: '/api/transactions',
    tags: ['Transactions'],
    summary: 'Search transactions',
    request: { query: wireInTransactions.SearchTransactionsQuerySchema },
    responses: {
      200: okResponse('Matching transactions', z.array(TransactionViewSchema)),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },

  {
    method: 'get',
    path: '/api/tags',
    tags: ['Tags'],
    summary: 'List tags',
    responses: { 200: okResponse('Tags', z.array(TagSchema)) },
  },
  {
    method: 'post',
    path: '/api/tags',
    tags: ['Tags'],
    summary: 'Create tag',
    request: { body: jsonBody(CreateTagSchema) },
    responses: { 201: okResponse('Tag created', TagSchema), 409: conflict409, 422: validation422 },
  },
  {
    method: 'delete',
    path: '/api/tags/{id}',
    tags: ['Tags'],
    summary: 'Delete tag',
    request: { params: idParam },
    responses: { 200: okResponse('Tag deleted', DeletedOut) },
  },

  {
    method: 'get',
    path: '/api/aggregate',
    tags: ['Aggregate'],
    summary: 'Aggregate spending',
    request: { query: AggregateSpendingInputSchema },
    responses: {
      200: okResponse('Aggregated spending', AggregateResultSchema),
      404: notFound404,
      409: conflict409,
      422: validation422,
    },
  },

  {
    method: 'get',
    path: '/api/summary',
    tags: ['Summary'],
    summary: 'Get spending summary',
    request: { query: CoercedPeriodSchema },
    responses: { 200: okResponse('Spending summary', SpendingSummaryOut), 422: validation422 },
  },
];

export const buildOpenApiDocument = (version: string): OpenAPIObject => {
  const registry = new OpenAPIRegistry();
  for (const route of routes) registry.registerPath(route);

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'FinTrack API',
      version,
      description:
        'REST contract for the FinTrack HTTP API (ADR-013). MCP (POST /mcp) is the primary surface; ' +
        'this document exists so agent-generated dashboards can call /api with correct request/response shapes.',
    },
  });
};
