import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createBudget, deleteBudget, getBudgetStatus, listBudgets, updateBudget } from '../../../controllers/budgets.js';
import { PeriodSchema } from '../../../models/date.js';
import { CurrencyCode } from '../../../models/money.js';
import { CreateBudgetSchema, UpdateBudgetSchema } from '../../../wire/in/budgets.js';
import * as budgetAdapters from '../../../adapters/budgets.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

export const registerBudgetTools = (server: McpServer, ctx: McpContext): void => {
  const { deps, runEffects } = ctx;

  server.registerTool(
    'create_budget',
    {
      annotations: MUTATING,
      title: 'Create budget',
      description:
        'Create a recurring monthly spending limit on a category or sub-category, in one currency ' +
        '(Feature Design 015). Provide exactly one of category/subCategory — a category budget rolls up its ' +
        "sub-categories' spend (the envelope behavior); a sub-category budget measures only its own spend, " +
        "and also counts toward its parent's budget if one exists. Rejected for an income-kind category " +
        '(a budget caps spending). Rejected as a duplicate if this exact (target, currency, period) already ' +
        'has a budget — use update_budget instead. Use get_budget_status to see spend-vs-limit.',
      inputSchema: CreateBudgetSchema.shape,
    },
    async (args) => {
      const flow = () => createBudget(deps, args).map(budgetAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'update_budget',
    {
      annotations: MUTATING,
      title: 'Update budget',
      description: "Update a budget's limit and/or period, identified by its id (from create_budget/list_budgets).",
      inputSchema: UpdateBudgetSchema.shape,
    },
    async (args) => {
      const flow = () => updateBudget(deps, args).map(budgetAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'delete_budget',
    {
      annotations: MUTATING,
      title: 'Delete budget',
      description: 'Delete a budget by id. Idempotent — deleting an already-absent id is not an error.',
      inputSchema: { id: z.string().min(1).describe('Budget id') },
    },
    async (args) => {
      const flow = () => deleteBudget(deps, args.id).map(budgetAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'list_budgets',
    {
      annotations: READ_ONLY,
      title: 'List budgets',
      description: 'List all budgets (the limits themselves, no spend) — use get_budget_status for spend-vs-limit.',
      inputSchema: {},
    },
    async () => json(await listBudgets(deps)),
  );

  server.registerTool(
    'get_budget_status',
    {
      annotations: READ_ONLY,
      title: 'Get budget status',
      description:
        'Spend-vs-limit for every budget in a month (Feature Design 015 phase 2, measurement revised by ' +
        "Feature Design 020) — grouped by top-level category so a category's own budget and each of its " +
        "sub-categories' own budgets read as one coherent unit; no cross-currency total on the per-currency " +
        'lines themselves (BRL and USD never mixed there). Reports two measures against each limit: ' +
        '`effective` (cleared spend only) and `committed` (effective + pending — the earmark-aware view of ' +
        "what's already spoken for); `pending` (committed - effective) is derived for convenience. Each " +
        'measure carries `amount` and `pct` (amount / limit); both sums are expense-only, same-currency ' +
        "(income and transfers never count, even on a both-kind category); a category budget rolls up its " +
        "sub-categories' spend, a sub-category budget measures only its own (and also counts toward its " +
        "parent's, if the parent has a budget too). `remaining` (limit - committed.amount) can go negative " +
        'when over budget — over-budget is reported, never an error. Optional displayCurrency adds a ' +
        'top-level converted block: a read-time grand total of committed spend across every budgeted ' +
        "category's currency, converted against currency_rates (as_of-stamped, stale-flagged; a currency " +
        'with no rate to displayCurrency is listed in converted.excluded and left out of the total, never ' +
        'fabricated). A spend row counted toward both a sub-category budget and its rolled-up parent budget ' +
        'contributes to this total once, not twice. Per-currency/per-category lines are unaffected either way.',
      inputSchema: {
        ...PeriodSchema.shape,
        displayCurrency: CurrencyCode.optional().describe(
          'Also return a converted grand total of committed spend in this currency',
        ),
      },
    },
    async (args) => json(await getBudgetStatus(deps, args, args.displayCurrency)),
  );
};
