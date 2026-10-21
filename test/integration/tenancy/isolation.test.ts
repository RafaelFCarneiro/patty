import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRouteDefinitions } from '../../../src/diplomat/http/routes.js';
import { documentationContext } from '../../../src/diplomat/http/context.js';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { toolScopesOf } from '../../../src/diplomat/mcp/scopes.js';
import { SHARED_DEFAULT_READ_ONLY_MESSAGE } from '../../../src/models/tenancy.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { seedProductPath, type Seeded } from './product-path.js';
import {
  callRoute,
  callTool,
  dumpOf,
  errorCodeOf,
  expectNoLeak,
  markersOf,
  postMcp,
  readResource,
  seedTwoUsers,
  sharedDump,
  WORLD_A,
  WORLD_B,
  type Actor,
  type Outcome,
  type World,
} from './world.js';

/**
 * User B acts against user A's data through every registered MCP tool, REST route and MCP resource, over HTTP with real
 * bearer tokens. The registries are read from the product, so a new tool or route fails the coverage test until it has
 * a case. Per call: nothing of A's is returned, A's ids and names are "not found" (never "forbidden"), and A's rows and
 * the shared defaults are unchanged.
 */

type Expected =
  /** A read: succeeds, mentions none of A's data. `contains` pins that B's own data is there (not a vacuous pass). */
  | { kind: 'scoped'; contains?: string[]; omits?: string[] }
  /** A write that is allowed for B (its own data, or shared reference data): succeeds and leaks nothing of A's. */
  | { kind: 'ok'; echoes?: boolean }
  /** A's id or name: refused as not found (or, for a default, as read-only). */
  | { kind: 'refused'; code: string }
  /** An idempotent delete of an id or name B cannot see: succeeds with `deleted: false`, as if absent. */
  | { kind: 'noop' }
  /** A bulk import answers 200 with a verdict per line: every line is refused for the same not-found reason. */
  | { kind: 'itemsRefused'; code: string };

type ToolCase = { args: (a: World, b: World) => Record<string, unknown>; expected: Expected };
type RouteCase = { call: (a: World, b: World) => { url: string; body?: unknown }; status: number; expected: Expected };

const notFound = (code: string): Expected => ({ kind: 'refused', code });
const scoped = (contains: string[] = [], omits: string[] = []): Expected => ({ kind: 'scoped', contains, omits });
const own: Expected = { kind: 'ok' };
const noop: Expected = { kind: 'noop' };
const everyLineRefused = (code: string): Expected => ({ kind: 'itemsRefused', code });

const STATEMENT_ITEM = { description: 'ZZ-B import', amount: 1, type: 'expense', date: '2026-09-02' } as const;
const enc = encodeURIComponent;
/** B reads in Spanish (its `user_settings`), so the default category 'Food' is 'Alimentación' to B. */
const FOOD_FOR_B = 'Alimentación';

const TOOL_CASES: Record<string, ToolCase | ToolCase[]> = {
  add_account_expense: {
    args: (a) => ({ description: 'x', amount: 1, account: a.acc1.name }),
    expected: notFound('unknown_account'),
  },
  add_account_income: {
    args: (a) => ({ description: 'x', amount: 1, account: a.acc1.name }),
    expected: notFound('unknown_account'),
  },
  import_account_statement: {
    args: (a) => ({ account: a.acc1.name, items: [STATEMENT_ITEM] }),
    expected: everyLineRefused('unknown_account'),
  },
  update_account_transaction: {
    args: (a) => ({ id: a.tx.expense, amount: 1 }),
    expected: notFound('unknown_transaction'),
  },
  delete_account_transaction: {
    args: (a) => ({ id: a.tx.expense, confirm: true }),
    expected: notFound('unknown_transaction'),
  },
  create_account: { args: (a) => ({ name: a.acc1.name, currency: 'USD' }), expected: { kind: 'ok', echoes: true } },
  get_account_balances: [
    { args: () => ({}), expected: scoped(['ZZ-B Checking'], ['ZZ-A']) },
    { args: (a) => ({ account: a.acc1.name }), expected: notFound('unknown_account') },
  ],
  list_accounts: { args: () => ({}), expected: scoped(['ZZ-B Checking', 'ZZ-B Savings']) },
  update_account: { args: (a) => ({ name: a.acc1.name, newName: 'stolen' }), expected: notFound('unknown_account') },
  delete_account: { args: (a) => ({ name: a.acc2.name }), expected: notFound('unknown_account') },
  import_card_statement: {
    args: (a) => ({ card: a.card.name, items: [STATEMENT_ITEM] }),
    expected: everyLineRefused('unknown_card'),
  },
  add_card_purchase: {
    args: (a) => ({ description: 'x', amount: 1, type: 'expense', card: a.card.name }),
    expected: notFound('unknown_card'),
  },
  create_credit_card: {
    args: (a) => ({ name: a.card.name, closingDay: 10, dueDay: 20, currency: 'USD' }),
    expected: { kind: 'ok', echoes: true },
  },
  list_credit_cards: { args: () => ({}), expected: scoped(['ZZ-B Visa']) },
  update_credit_card: { args: (a) => ({ name: a.card.name, closingDay: 5 }), expected: notFound('unknown_card') },
  delete_credit_card: { args: (a) => ({ card: a.card.name, confirm: true }), expected: notFound('unknown_card') },
  get_bill: {
    args: (a) => ({ card: a.card.name, month: a.bill.month, year: a.bill.year }),
    expected: notFound('unknown_card'),
  },
  pay_bill: {
    args: (a) => ({ card: a.card.name, month: a.bill.month, year: a.bill.year, account: a.acc1.name }),
    expected: notFound('unknown_card'),
  },
  revert_bill_payment: {
    args: (a) => ({ card: a.card.name, month: a.bill.month, year: a.bill.year }),
    expected: notFound('unknown_card'),
  },
  update_card_transaction: {
    args: (a) => ({ id: a.tx.cardPurchase, amount: 1 }),
    expected: notFound('unknown_transaction'),
  },
  delete_card_transaction: {
    args: (a) => ({ id: a.tx.cardPurchase, confirm: true }),
    expected: notFound('unknown_transaction'),
  },
  // Exchange rates are shared market data: any signed-in user reads and refreshes them.
  set_exchange_rate: {
    args: () => ({ from: 'USD', to: 'BRL', rate: 5, asOf: '2026-10-01T00:00:00.000Z' }),
    expected: own,
  },
  set_exchange_rates: {
    args: () => ({ rates: [{ from: 'USD', to: 'USDC', rate: 1, asOf: '2026-10-01T00:00:00.000Z' }] }),
    expected: own,
  },
  list_exchange_rates: { args: () => ({}), expected: scoped() },
  confirm_transaction: { args: (a) => ({ id: a.tx.pending }), expected: notFound('unknown_transaction') },
  search_transactions: [
    { args: () => ({}), expected: scoped(['ZZ-B Groceries'], ['ZZ-A']) },
    { args: () => ({ text: 'ZZ-A' }), expected: scoped([], ['ZZ-A']) },
    { args: (a) => ({ account: a.acc1.name }), expected: notFound('unknown_account') },
    { args: (a) => ({ tags: [a.tag.name] }), expected: scoped([], ['ZZ-A']) },
    { args: (a) => ({ category: a.category.name }), expected: notFound('unknown_category') },
  ],
  create_transfer: [
    { args: (a, b) => ({ from: a.acc1.name, to: b.acc1.name, amount: 1 }), expected: notFound('unknown_account') },
    { args: (a, b) => ({ from: b.acc1.name, to: a.acc2.name, amount: 1 }), expected: notFound('unknown_account') },
  ],
  create_budget: { args: () => ({ category: 'Food', currency: 'BRL', limit: 10 }), expected: own },
  update_budget: { args: (a) => ({ id: a.budget.id, limit: 1 }), expected: notFound('unknown_budget') },
  delete_budget: { args: (a) => ({ id: a.budget.id }), expected: noop },
  list_budgets: { args: () => ({}), expected: scoped([FOOD_FOR_B]) },
  get_budget_status: { args: (a) => ({ month: a.bill.month, year: a.bill.year }), expected: scoped([FOOD_FOR_B]) },
  create_recurring: {
    args: (a) => ({
      description: 'x',
      amount: 1,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-10-01',
      account: a.acc1.name,
    }),
    expected: notFound('unknown_account'),
  },
  list_recurring: { args: () => ({}), expected: scoped(['ZZ-B Rent']) },
  apply_due_recurring: { args: () => ({}), expected: { kind: 'ok' } },
  create_category: {
    args: (a) => ({ name: a.category.name, kind: 'expense' }),
    expected: { kind: 'ok', echoes: true },
  },
  list_categories: { args: () => ({}), expected: scoped([FOOD_FOR_B, 'ZZ-B Pets']) },
  create_sub_category: {
    args: (a) => ({ name: 'x', parentId: a.category.id }),
    expected: notFound('unknown_category'),
  },
  list_sub_categories: [
    { args: () => ({}), expected: scoped(['ZZ-B Vet'], ['ZZ-A']) },
    { args: (a) => ({ parentId: a.category.id }), expected: scoped([], ['ZZ-A']) },
  ],
  delete_category: { args: (a) => ({ name: a.category.name }), expected: notFound('unknown_category') },
  delete_sub_category: [
    { args: (a) => ({ name: a.subCategory.name }), expected: notFound('unknown_sub_category') },
    { args: (a) => ({ name: a.subUnderDefault.name }), expected: notFound('unknown_sub_category') },
  ],
  list_tags: { args: () => ({}), expected: scoped(['zz-b-tag']) },
  create_tag: { args: (a) => ({ name: a.tag.name }), expected: { kind: 'ok', echoes: true } },
  delete_tag: { args: (a) => ({ id: a.tag.id }), expected: noop },
  save_dashboard: {
    args: (a) => ({ name: a.dashboard.name, html: '<section>mine</section>' }),
    expected: { kind: 'ok', echoes: true },
  },
  list_dashboards: { args: () => ({}), expected: scoped(['overview', 'zz-b-board']) },
  delete_dashboard: { args: (a) => ({ name: a.dashboard.name }), expected: noop },
  rename_dashboard: {
    args: (a) => ({ name: a.dashboard.name, newName: 'stolen' }),
    expected: notFound('unknown_dashboard'),
  },
  find_correlations: [
    { args: (a) => ({ analysis: 'spending_shifts', month: a.bill.month, year: a.bill.year }), expected: scoped() },
    { args: (a) => ({ analysis: 'budget_fit', month: a.bill.month, year: a.bill.year }), expected: scoped() },
    {
      args: (a) => ({ analysis: 'merchant_concentration', month: a.bill.month, year: a.bill.year }),
      expected: scoped(),
    },
    {
      args: (a) => ({
        analysis: 'merchant_concentration',
        month: a.bill.month,
        year: a.bill.year,
        category: a.category.name,
      }),
      expected: notFound('unknown_category'),
    },
    { args: () => ({ analysis: 'recurring_candidates' }), expected: scoped() },
  ],
  aggregate_spending: [
    { args: () => ({ groupBy: 'category', month: 9, year: 2026 }), expected: scoped([FOOD_FOR_B]) },
    { args: () => ({ groupBy: 'account', month: 9, year: 2026 }), expected: scoped(['ZZ-B Checking']) },
    { args: () => ({ groupBy: 'tag', month: 9, year: 2026 }), expected: scoped(['zz-b-tag']) },
    { args: () => ({ groupBy: 'month', month: 9, year: 2026 }), expected: scoped() },
    { args: () => ({ groupBy: 'merchant', month: 9, year: 2026 }), expected: scoped() },
    {
      args: (a) => ({ groupBy: 'category', month: 9, year: 2026, account: a.acc1.name }),
      expected: notFound('unknown_account'),
    },
  ],
  get_spending_summary: { args: (a) => ({ month: a.bill.month, year: a.bill.year }), expected: scoped([FOOD_FOR_B]) },
  set_locale: { args: () => ({ locale: 'pt', source: 'explicit' }), expected: { kind: 'ok' } },
  get_preferences: { args: () => ({}), expected: scoped() },
  set_base_currency: { args: () => ({ baseCurrency: 'BTC' }), expected: { kind: 'ok' } },
  get_status: { args: () => ({}), expected: scoped() },
};

const ROUTE_CASES: Record<string, RouteCase | RouteCase[]> = {
  'GET /api/health': { call: () => ({ url: '/api/health' }), status: 200, expected: scoped() },
  'GET /api/status': { call: () => ({ url: '/api/status' }), status: 200, expected: scoped() },
  'GET /api/accounts': { call: () => ({ url: '/api/accounts' }), status: 200, expected: scoped(['ZZ-B Checking']) },
  'GET /api/accounts/balances': [
    { call: () => ({ url: '/api/accounts/balances' }), status: 200, expected: scoped(['ZZ-B Checking']) },
    {
      call: (a) => ({ url: `/api/accounts/balances?account=${enc(a.acc1.name)}` }),
      status: 404,
      expected: notFound('unknown_account'),
    },
  ],
  'POST /api/accounts': {
    call: (a) => ({ url: '/api/accounts', body: { name: a.acc1.name, currency: 'USD' } }),
    status: 201,
    expected: { kind: 'ok', echoes: true },
  },
  'PATCH /api/accounts/:name': {
    call: (a) => ({ url: `/api/accounts/${enc(a.acc1.name)}`, body: { newName: 'stolen' } }),
    status: 404,
    expected: notFound('unknown_account'),
  },
  'DELETE /api/accounts/:name': {
    call: (a) => ({ url: `/api/accounts/${enc(a.acc2.name)}` }),
    status: 404,
    expected: notFound('unknown_account'),
  },
  'POST /api/accounts/expenses': {
    call: (a) => ({ url: '/api/accounts/expenses', body: { description: 'x', amount: 1, account: a.acc1.name } }),
    status: 404,
    expected: notFound('unknown_account'),
  },
  'POST /api/accounts/income': {
    call: (a) => ({ url: '/api/accounts/income', body: { description: 'x', amount: 1, account: a.acc1.name } }),
    status: 404,
    expected: notFound('unknown_account'),
  },
  'POST /api/accounts/statement': {
    call: (a) => ({ url: '/api/accounts/statement', body: { account: a.acc1.name, items: [STATEMENT_ITEM] } }),
    status: 200,
    expected: everyLineRefused('unknown_account'),
  },
  'PATCH /api/accounts/transactions/:id': {
    call: (a) => ({ url: `/api/accounts/transactions/${a.tx.expense}`, body: { amount: 1 } }),
    status: 404,
    expected: notFound('unknown_transaction'),
  },
  'DELETE /api/accounts/transactions/:id': {
    call: (a) => ({ url: `/api/accounts/transactions/${a.tx.expense}?confirm=true` }),
    status: 404,
    expected: notFound('unknown_transaction'),
  },
  'GET /api/categories': {
    call: () => ({ url: '/api/categories' }),
    status: 200,
    expected: scoped([FOOD_FOR_B, 'ZZ-B Pets']),
  },
  'POST /api/categories': {
    call: (a) => ({ url: '/api/categories', body: { name: a.category.name, kind: 'expense' } }),
    status: 201,
    expected: { kind: 'ok', echoes: true },
  },
  'GET /api/sub-categories': [
    { call: () => ({ url: '/api/sub-categories' }), status: 200, expected: scoped(['ZZ-B Vet'], ['ZZ-A']) },
    {
      call: (a) => ({ url: `/api/sub-categories?parentId=${a.category.id}` }),
      status: 200,
      expected: scoped([], ['ZZ-A']),
    },
  ],
  'POST /api/sub-categories': {
    call: (a) => ({ url: '/api/sub-categories', body: { name: 'x', parentId: a.category.id } }),
    status: 404,
    expected: notFound('unknown_category'),
  },
  'DELETE /api/categories/:name': {
    call: (a) => ({ url: `/api/categories/${enc(a.category.name)}` }),
    status: 404,
    expected: notFound('unknown_category'),
  },
  'DELETE /api/sub-categories/:name': {
    call: (a) => ({ url: `/api/sub-categories/${enc(a.subCategory.name)}` }),
    status: 404,
    expected: notFound('unknown_sub_category'),
  },
  'POST /api/credit-cards/purchases': {
    call: (a) => ({
      url: '/api/credit-cards/purchases',
      body: { description: 'x', amount: 1, type: 'expense', card: a.card.name },
    }),
    status: 404,
    expected: notFound('unknown_card'),
  },
  'POST /api/credit-cards/statement': {
    call: (a) => ({ url: '/api/credit-cards/statement', body: { card: a.card.name, items: [STATEMENT_ITEM] } }),
    status: 200,
    expected: everyLineRefused('unknown_card'),
  },
  'GET /api/credit-cards': { call: () => ({ url: '/api/credit-cards' }), status: 200, expected: scoped(['ZZ-B Visa']) },
  'POST /api/credit-cards': {
    call: (a) => ({
      url: '/api/credit-cards',
      body: { name: a.card.name, closingDay: 10, dueDay: 20, currency: 'USD' },
    }),
    status: 201,
    expected: { kind: 'ok', echoes: true },
  },
  'PATCH /api/credit-cards/:name': {
    call: (a) => ({ url: `/api/credit-cards/${enc(a.card.name)}`, body: { closingDay: 5 } }),
    status: 404,
    expected: notFound('unknown_card'),
  },
  'DELETE /api/credit-cards/:name': {
    call: (a) => ({ url: `/api/credit-cards/${enc(a.card.name)}?confirm=true` }),
    status: 404,
    expected: notFound('unknown_card'),
  },
  'GET /api/bills': {
    call: (a) => ({ url: `/api/bills?card=${enc(a.card.name)}&month=${a.bill.month}&year=${a.bill.year}` }),
    status: 404,
    expected: notFound('unknown_card'),
  },
  'POST /api/bills/pay': {
    call: (a) => ({
      url: '/api/bills/pay',
      body: { card: a.card.name, month: a.bill.month, year: a.bill.year, account: a.acc1.name },
    }),
    status: 404,
    expected: notFound('unknown_card'),
  },
  'POST /api/bills/revert': {
    call: (a) => ({ url: '/api/bills/revert', body: { card: a.card.name, month: a.bill.month, year: a.bill.year } }),
    status: 404,
    expected: notFound('unknown_card'),
  },
  'PATCH /api/credit-cards/transactions/:id': {
    call: (a) => ({ url: `/api/credit-cards/transactions/${a.tx.cardPurchase}`, body: { amount: 1 } }),
    status: 404,
    expected: notFound('unknown_transaction'),
  },
  'DELETE /api/credit-cards/transactions/:id': {
    call: (a) => ({ url: `/api/credit-cards/transactions/${a.tx.cardPurchase}?confirm=true` }),
    status: 404,
    expected: notFound('unknown_transaction'),
  },
  'GET /api/currencies': { call: () => ({ url: '/api/currencies' }), status: 200, expected: scoped(['USD']) },
  'GET /api/exchange-rates': { call: () => ({ url: '/api/exchange-rates' }), status: 200, expected: scoped() },
  'POST /api/exchange-rates': {
    call: () => ({
      url: '/api/exchange-rates',
      body: { from: 'USD', to: 'BRL', rate: 5, asOf: '2026-10-01T00:00:00.000Z' },
    }),
    status: 200,
    expected: own,
  },
  'POST /api/exchange-rates/bulk': {
    call: () => ({
      url: '/api/exchange-rates/bulk',
      body: { rates: [{ from: 'USD', to: 'USDC', rate: 1, asOf: '2026-10-01T00:00:00.000Z' }] },
    }),
    status: 200,
    expected: own,
  },
  'GET /api/preferences': { call: () => ({ url: '/api/preferences' }), status: 200, expected: scoped() },
  'POST /api/settings/base-currency': {
    call: () => ({ url: '/api/settings/base-currency', body: { baseCurrency: 'BTC' } }),
    status: 200,
    expected: own,
  },
  'POST /api/transfers': {
    call: (a, b) => ({ url: '/api/transfers', body: { from: a.acc1.name, to: b.acc1.name, amount: 1 } }),
    status: 404,
    expected: notFound('unknown_account'),
  },
  'GET /api/recurring': { call: () => ({ url: '/api/recurring' }), status: 200, expected: scoped(['ZZ-B Rent']) },
  'POST /api/recurring': {
    call: (a) => ({
      url: '/api/recurring',
      body: {
        description: 'x',
        amount: 1,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-10-01',
        account: a.acc1.name,
      },
    }),
    status: 404,
    expected: notFound('unknown_account'),
  },
  'POST /api/recurring/apply-due': {
    call: () => ({ url: '/api/recurring/apply-due', body: {} }),
    status: 200,
    expected: own,
  },
  'POST /api/transactions/:id/confirm': {
    call: (a) => ({ url: `/api/transactions/${a.tx.pending}/confirm`, body: {} }),
    status: 404,
    expected: notFound('unknown_transaction'),
  },
  'GET /api/transactions': [
    { call: () => ({ url: '/api/transactions' }), status: 200, expected: scoped(['ZZ-B Groceries'], ['ZZ-A']) },
    { call: () => ({ url: '/api/transactions?text=ZZ-A' }), status: 200, expected: scoped([], ['ZZ-A']) },
    {
      call: (a) => ({ url: `/api/transactions?account=${enc(a.acc1.name)}` }),
      status: 404,
      expected: notFound('unknown_account'),
    },
  ],
  'GET /api/tags': { call: () => ({ url: '/api/tags' }), status: 200, expected: scoped(['zz-b-tag']) },
  'POST /api/tags': {
    call: (a) => ({ url: '/api/tags', body: { name: a.tag.name } }),
    status: 201,
    expected: { kind: 'ok', echoes: true },
  },
  'DELETE /api/tags/:id': { call: (a) => ({ url: `/api/tags/${a.tag.id}` }), status: 200, expected: noop },
  'GET /api/dashboards': {
    call: () => ({ url: '/api/dashboards' }),
    status: 200,
    expected: scoped(['overview', 'zz-b-board']),
  },
  'GET /api/dashboards/:name': [
    {
      call: (a) => ({ url: `/api/dashboards/${enc(a.dashboard.name)}` }),
      status: 404,
      expected: notFound('unknown_dashboard'),
    },
    {
      call: (_a, b) => ({ url: `/api/dashboards/${enc(b.dashboard.name)}` }),
      status: 200,
      expected: scoped(['ZZ-B private dashboard']),
    },
  ],
  'POST /api/dashboards': {
    call: (a) => ({ url: '/api/dashboards', body: { name: a.dashboard.name, html: '<section>mine</section>' } }),
    status: 200,
    expected: { kind: 'ok', echoes: true },
  },
  'DELETE /api/dashboards/:name': {
    call: (a) => ({ url: `/api/dashboards/${enc(a.dashboard.name)}` }),
    status: 200,
    expected: noop,
  },
  'POST /api/dashboards/:name/rename': {
    call: (a) => ({ url: `/api/dashboards/${enc(a.dashboard.name)}/rename`, body: { newName: 'stolen' } }),
    status: 404,
    expected: notFound('unknown_dashboard'),
  },
  'GET /api/aggregate': [
    {
      call: () => ({ url: '/api/aggregate?groupBy=category&month=9&year=2026' }),
      status: 200,
      expected: scoped([FOOD_FOR_B]),
    },
    {
      call: (a) => ({ url: `/api/aggregate?groupBy=category&month=9&year=2026&account=${enc(a.acc1.name)}` }),
      status: 404,
      expected: notFound('unknown_account'),
    },
  ],
  'GET /api/summary': {
    call: (a) => ({ url: `/api/summary?month=${a.bill.month}&year=${a.bill.year}` }),
    status: 200,
    expected: scoped([FOOD_FOR_B]),
  },
  'GET /api/budgets': { call: () => ({ url: '/api/budgets' }), status: 200, expected: scoped([FOOD_FOR_B]) },
  'GET /api/budgets/status': {
    call: (a) => ({ url: `/api/budgets/status?month=${a.bill.month}&year=${a.bill.year}` }),
    status: 200,
    expected: scoped([FOOD_FOR_B]),
  },
};

const RESOURCE_CASES: Record<string, { contains: string[]; omits: string[] }> = {
  'fintrack://accounts': { contains: ['ZZ-B Checking'], omits: ['ZZ-A'] },
  'fintrack://categories': { contains: [FOOD_FOR_B, 'ZZ-B Pets'], omits: ['ZZ-A'] },
  'fintrack://tags': { contains: ['zz-b-tag'], omits: ['zz-a-'] },
  'fintrack://credit-cards': { contains: ['ZZ-B Visa'], omits: ['ZZ-A'] },
  'fintrack://merchants/top': { contains: [], omits: ['ZZ-A', 'zzashop'] },
  'fintrack://currencies': { contains: ['USD'], omits: ['ZZ-A'] },
  'fintrack://exchange-rates': { contains: [], omits: ['ZZ-A'] },
  'fintrack://openapi': { contains: ['/api/accounts'], omits: ['ZZ-A'] },
};

/**
 * The suite runs twice over the same table of attacks. First with B's row inserted straight into the database; then
 * with B created through the PRODUCT path — invited by an admin, the invite claimed, B's Claude signed in over stdio at
 * `/ui/connect` — so the isolation holds for a user that exists the way users really come to exist.
 */
const SETUPS: ReadonlyArray<readonly [string, (ctx: AppContext) => Promise<Seeded>]> = [
  ['B inserted as a row', seedTwoUsers],
  ['B invited, claimed and signed in over stdio', seedProductPath],
];

describe.each(SETUPS)('%s', (_setup, seed) => {
  let ctx: AppContext;
  let a: Actor;
  let b: Actor;

  type Harness = { ctx: AppContext; a: Actor; b: Actor; dir: string; close?: () => Promise<void> };

  /** A fresh app and database holding the two users' worlds. */
  const startHarness = async (): Promise<Harness> => {
    const dir = mkdtempSync(join(tmpdir(), 'fintrack-isolation-'));
    const app = await buildApp({ dbPath: join(dir, 'test.db'), auth: {} });
    await app.app.ready();
    return { ctx: app, ...(await seed(app)), dir };
  };

  const stopHarness = async (h: Harness): Promise<void> => {
    await h.close?.();
    await h.ctx.app.close();
    rmSync(h.dir, { recursive: true, force: true });
  };

  let main: Harness;

  beforeAll(async () => {
    main = await startHarness();
    ({ ctx, a, b } = main);
  });

  afterAll(async () => {
    await stopHarness(main);
  });

  const asList = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

  /** A call that B is ALLOWED to make with A's names — it creates B's own thing under A's name (names are per user), or
   *  changes B's own preferences — runs after every attack in this suite. Before then it would hand B a same-named
   *  account, card or category of its own, and a later "A's name is not found" would no longer be a fair question. */
  const changesBsOwnState = (expected: Expected): boolean => expected.kind === 'ok';

  const checkOutcome = (outcome: Outcome, expected: Expected, label: string, status?: number): void => {
    switch (expected.kind) {
      case 'refused':
        expect(outcome.failed, `${label} should be refused: ${outcome.text.slice(0, 300)}`).toBe(true);
        expect(errorCodeOf(outcome), label).toBe(expected.code);
        if (status !== undefined) expect(outcome.status, label).toBe(status);
        return;
      case 'noop':
        expect(outcome.failed, `${label} should answer deleted:false: ${outcome.text.slice(0, 300)}`).toBe(false);
        expect((outcome.payload as { deleted?: boolean }).deleted, label).toBe(false);
        return;
      case 'itemsRefused': {
        expect(outcome.failed, `${label} answers per line: ${outcome.text.slice(0, 300)}`).toBe(false);
        const body = outcome.payload as {
          summary: { created: number };
          items: Array<{ status: string; error?: string }>;
        };
        expect(body.summary.created, label).toBe(0);
        expect(body.items.length, label).toBeGreaterThan(0);
        for (const item of body.items) {
          expect(item.status, label).toBe('error');
          expect(item.error, label).toMatch(new RegExp(`^${expected.code}`));
          // The line's message repeats what B asked for; what it lists as candidates must be B's alone.
          const candidates = item.error?.split('(candidates:')[1] ?? '';
          expect(
            markersOf(WORLD_A).filter((marker) => candidates.includes(marker)),
            `${label} candidates`,
          ).toEqual([]);
        }
        return;
      }
      case 'scoped':
      case 'ok':
        expect(outcome.failed, `${label} should succeed: ${outcome.text.slice(0, 300)}`).toBe(false);
        if (expected.kind === 'scoped') {
          for (const text of expected.contains ?? [])
            expect(outcome.text, `${label} should show B's ${text}`).toContain(text);
          for (const text of expected.omits ?? [])
            expect(outcome.text, `${label} should omit ${text}`).not.toContain(text);
        }
        return;
    }
  };

  /** What a case must satisfy beyond its own expectation: nothing of A's in the answer, A's rows and the shared
   *  defaults exactly as they were. */
  const isolated = async (
    label: string,
    expected: Expected,
    run: () => Promise<Outcome>,
    status?: number,
  ): Promise<void> => {
    const aBefore = await dumpOf(ctx.db, WORLD_A.userId);
    const sharedBefore = await sharedDump(ctx.db);

    const outcome = await run();

    checkOutcome(outcome, expected, label, status);
    if (!(expected.kind === 'ok' && expected.echoes) && expected.kind !== 'itemsRefused')
      expectNoLeak(outcome, WORLD_A, label);
    expect(await dumpOf(ctx.db, WORLD_A.userId), `${label} changed A's rows`).toEqual(aBefore);
    expect(await sharedDump(ctx.db), `${label} changed the shared defaults`).toEqual(sharedBefore);
  };

  describe('the surface under test is the whole surface', () => {
    const tools = [...toolScopesOf(buildMcpServer({} as never, '0', { gate: ownerGate })).keys()].sort();
    const routes = buildRouteDefinitions(documentationContext('0')).map(
      ({ method, path }) => `${method.toUpperCase()} ${path}`,
    );

    it('has an isolation case for every registered MCP tool, and none for a tool that no longer exists', () => {
      expect(tools.length).toBeGreaterThan(50);
      expect(Object.keys(TOOL_CASES).sort()).toEqual(tools);
    });

    it('has an isolation case for every REST route, and none for a route that no longer exists', () => {
      expect(routes.length).toBeGreaterThan(45);
      expect(Object.keys(ROUTE_CASES).sort()).toEqual([...routes].sort());
    });

    it('has an isolation case for every MCP resource the server lists', async () => {
      const res = await postMcp(ctx.app, b, { jsonrpc: '2.0', id: 9, method: 'resources/list' });
      const listed = (res.json as { result: { resources: Array<{ uri: string }> } }).result.resources.map((r) => r.uri);
      expect(Object.keys(RESOURCE_CASES).sort()).toEqual([...listed].sort());
    });

    it('seeds two users whose worlds really are disjoint (the fixtures themselves are sound)', async () => {
      for (const [mine, theirs] of [
        [a.world, b.world],
        [b.world, a.world],
      ] as const) {
        const dump = JSON.stringify(await dumpOf(ctx.db, mine.userId));
        expect(markersOf(theirs).filter((marker) => dump.includes(marker))).toEqual([]);
        expect(dump).toContain(`ZZ-${mine.label}`);
      }
    });
  });

  const toolSweep = (phase: 'attacks' | 'allowed'): void => {
    for (const [tool, cases] of Object.entries(TOOL_CASES)) {
      asList(cases)
        .map((toolCase, index) => ({ toolCase, index }))
        .filter(({ toolCase }) => changesBsOwnState(toolCase.expected) === (phase === 'allowed'))
        .forEach(({ toolCase, index }) => {
          it(`${tool}${asList(cases).length > 1 ? ` #${index + 1}` : ''}`, async () => {
            await isolated(tool, toolCase.expected, () => callTool(ctx.app, b, tool, toolCase.args(WORLD_A, WORLD_B)));
          });
        });
    }
  };

  const routeSweep = (phase: 'attacks' | 'allowed'): void => {
    for (const [route, cases] of Object.entries(ROUTE_CASES)) {
      asList(cases)
        .map((routeCase, index) => ({ routeCase, index }))
        .filter(({ routeCase }) => changesBsOwnState(routeCase.expected) === (phase === 'allowed'))
        .forEach(({ routeCase, index }) => {
          it(`${route}${asList(cases).length > 1 ? ` #${index + 1}` : ''}`, async () => {
            const [method] = route.split(' ') as ['GET' | 'POST' | 'PATCH' | 'DELETE'];
            const { url, body } = routeCase.call(WORLD_A, WORLD_B);
            await isolated(route, routeCase.expected, () => callRoute(ctx.app, b, method, url, body), routeCase.status);
          });
        });
    }
  };

  describe('user B against user A, through every MCP tool', () => {
    toolSweep('attacks');
  });

  describe('user B against user A, through every REST route', () => {
    routeSweep('attacks');
  });

  describe('user B against user A, through every MCP resource', () => {
    for (const [uri, expectation] of Object.entries(RESOURCE_CASES)) {
      it(uri, async () => {
        const outcome = await readResource(ctx.app, b, uri);
        expect(outcome.failed, outcome.text.slice(0, 300)).toBe(false);
        for (const text of expectation.contains) expect(outcome.text).toContain(text);
        for (const text of expectation.omits) expect(outcome.text).not.toContain(text);
        expectNoLeak(outcome, WORLD_A, uri);
      });
    }
  });

  /** Each surface gets a world of its own: the first to create "ZZ-A Checking" for B would make the second one a
   *  duplicate of B's own. */
  const inFreshWorld = (title: string, sweep: () => void): void => {
    describe(title, () => {
      let fresh: Harness;
      beforeAll(async () => {
        fresh = await startHarness();
        ({ ctx, a, b } = fresh);
      });
      afterAll(async () => {
        await stopHarness(fresh);
        ({ ctx, a, b } = main);
      });
      sweep();
    });
  };

  describe('what B may do with A’s names and ids (its own data, shared reference), after the attacks', () => {
    inFreshWorld('MCP tools', () => toolSweep('allowed'));
    inFreshWorld('REST routes', () => routeSweep('allowed'));
  });

  describe('the other direction: user A against user B (the suite is symmetric, not a one-way mirror)', () => {
    it('A cannot reach B’s accounts, cards or transactions by name or id either', async () => {
      const bBefore = await dumpOf(ctx.db, b.world.userId);
      const calls: Array<[string, Record<string, unknown>]> = [
        ['delete_account', { name: WORLD_B.acc1.name }],
        ['update_account', { name: WORLD_B.acc1.name, newName: 'stolen' }],
        ['get_bill', { card: WORLD_B.card.name, month: 9, year: 2026 }],
        ['delete_card_transaction', { id: WORLD_B.tx.cardPurchase, confirm: true }],
        ['update_budget', { id: WORLD_B.budget.id, limit: 1 }],
        ['rename_dashboard', { name: WORLD_B.dashboard.name, newName: 'stolen' }],
      ];
      for (const [tool, args] of calls) {
        const outcome = await callTool(ctx.app, a, tool, args);
        expect(outcome.failed, tool).toBe(true);
        expect(errorCodeOf(outcome), tool).toMatch(/^unknown_/);
        expectNoLeak(outcome, WORLD_B, tool);
      }
      expect(await dumpOf(ctx.db, b.world.userId)).toEqual(bBefore);
    });
  });

  describe('the shared defaults are read-only for everyone', () => {
    it.each([
      ['A', () => a],
      ['B', () => b],
    ])('%s cannot delete a default category, or rename or delete a bundled dashboard', async (_who, actor) => {
      const before = await sharedDump(ctx.db);

      const category = await callTool(ctx.app, actor(), 'delete_category', { name: 'Food' });
      const rename = await callTool(ctx.app, actor(), 'rename_dashboard', { name: 'overview', newName: 'mine' });
      const remove = await callTool(ctx.app, actor(), 'delete_dashboard', { name: 'overview' });
      const restRename = await callRoute(ctx.app, actor(), 'POST', '/api/dashboards/overview/rename', {
        newName: 'mine',
      });
      const restDelete = await callRoute(ctx.app, actor(), 'DELETE', '/api/categories/Food');

      for (const outcome of [category, rename, remove, restRename, restDelete]) {
        expect(outcome.failed, outcome.text).toBe(true);
        expect(JSON.stringify(outcome.payload)).toContain(SHARED_DEFAULT_READ_ONLY_MESSAGE);
      }
      expect(await sharedDump(ctx.db)).toEqual(before);
    });

    it('both users see the same defaults', async () => {
      for (const actor of [a, b]) {
        const categoriesSeen = await callTool(ctx.app, actor, 'list_categories');
        expect(categoriesSeen.text).toContain('cat-food');
        const dashboardsSeen = await callTool(ctx.app, actor, 'list_dashboards');
        expect(dashboardsSeen.text).toContain('overview');
      }
    });
  });
});
