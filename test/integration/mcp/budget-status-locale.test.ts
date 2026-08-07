import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, ensure, makeClient } from './helpers.js';

type Budget = { id?: string; category?: string; subCategory?: string; currency?: string };
type BudgetStatusLine = { category?: string };
type BudgetStatusGroup = { category?: string; lines?: BudgetStatusLine[] };
type BudgetStatus = { categories?: BudgetStatusGroup[] };

const STATUS_PERIOD = { month: 1, year: 2026 };

/** Locale-aware coverage for the budgets read surface (Feature Design 020) — `get_budget_status`
 *  and `list_budgets` both join through a seeded (translated) category, so they must return the
 *  locale-resolved display name, not the raw English one, mirroring `summary-locale.test.ts`. */
describe('MCP integration > budgets read surface locale', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let budgetId: string;

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    const budget = (await callTool(client, {
      name: 'create_budget',
      args: { category: 'Food', currency: 'BRL', limit: 500 },
    })) as Budget;
    ensure(budget.id, 'budget id missing');
    budgetId = budget.id;
  });

  afterAll(async () => {
    await callTool(client, { name: 'delete_budget', args: { id: budgetId } });
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    await transport.close();
  });

  it('list_budgets returns the pt category name when locale is pt', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } });
    const budgets = (await callTool(client, { name: 'list_budgets', args: {} })) as Budget[];
    const budget = budgets.find((b) => b.id === budgetId);
    expect(budget?.category).toBe('Alimentação');
  });

  it('list_budgets returns the en category name when locale is en', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    const budgets = (await callTool(client, { name: 'list_budgets', args: {} })) as Budget[];
    const budget = budgets.find((b) => b.id === budgetId);
    expect(budget?.category).toBe('Food');
  });

  it('get_budget_status groups by the pt category name when locale is pt', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } });
    const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
    expect(status.categories?.some((g) => g.category === 'Alimentação')).toBe(true);
    expect(status.categories?.some((g) => g.category === 'Food')).toBe(false);
  });

  it('get_budget_status groups by the en category name when locale is en', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
    expect(status.categories?.some((g) => g.category === 'Food')).toBe(true);
  });

  it('update_budget response follows the resolved locale too', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'explicit' } });
    const updated = (await callTool(client, { name: 'update_budget', args: { id: budgetId, limit: 600 } })) as Budget;
    expect(updated.category).toBe('Alimentación');
  });
});
