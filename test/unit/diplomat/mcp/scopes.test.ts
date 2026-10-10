import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Deps, RunEffects, RunEffectsSequence } from '../../../../src/controllers/deps.js';
import { authInfoOf } from '../../../../src/diplomat/mcp/authInfo.js';
import { guardToolScopes, toolScopesOf } from '../../../../src/diplomat/mcp/scopes.js';
import { buildMcpServer } from '../../../../src/diplomat/mcp/server.js';
import { OWNER_PRINCIPAL, PrincipalVia, Scope, UserRole } from '../../../../src/models/auth.js';

const READ = Scope.enum['fintrack:read'];
const WRITE = Scope.enum['fintrack:write'];

type Registered = Record<string, { handler: (...args: unknown[]) => Promise<{ isError?: boolean; content: unknown }> }>;
const registeredTools = (server: McpServer): Registered =>
  (server as unknown as { _registeredTools: Registered })._registeredTools;

const textOf = (result: { content: unknown }): string => JSON.stringify(result.content);

describe('guardToolScopes', () => {
  const guarded = (requireAuthInfo: boolean) => {
    const server = new McpServer({ name: 'test', version: '0' });
    guardToolScopes(server, { requireAuthInfo });
    return server;
  };

  it('refuses to register a tool that does not declare readOnlyHint', () => {
    const server = guarded(false);
    expect(() =>
      server.registerTool('undeclared', { title: 'x', inputSchema: {} }, async () => ({ content: [] })),
    ).toThrow(/undeclared.*readOnlyHint/);
    expect(() =>
      server.registerTool('half', { annotations: { title: 'x' }, inputSchema: {} }, async () => ({ content: [] })),
    ).toThrow(/half.*readOnlyHint/);
  });

  it('derives each tool’s scope from its readOnlyHint', () => {
    const server = guarded(false);
    server.registerTool('reads', { annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
    server.registerTool('writes', { annotations: { readOnlyHint: false } }, async () => ({ content: [] }));
    expect(Object.fromEntries(toolScopesOf(server))).toEqual({ reads: READ, writes: WRITE });
  });

  it('runs the tool for a principal whose scopes cover it — with and without an input schema', async () => {
    const server = guarded(true);
    const withInput = vi.fn(async (args: { n: number }) => ({
      content: [{ type: 'text' as const, text: `n=${args.n}` }],
    }));
    const noInput = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }));
    server.registerTool(
      'with_input',
      { annotations: { readOnlyHint: false }, inputSchema: { n: z.number() } },
      withInput,
    );
    server.registerTool('no_input', { annotations: { readOnlyHint: true } }, noInput);
    const tools = registeredTools(server);

    const extra = { authInfo: authInfoOf(OWNER_PRINCIPAL) };
    expect(textOf(await tools.with_input!.handler({ n: 4 }, extra))).toContain('n=4');
    expect(textOf(await tools.no_input!.handler(extra))).toContain('done');
    expect(withInput).toHaveBeenCalledOnce();
    expect(noInput).toHaveBeenCalledOnce();
  });

  it('answers insufficient_scope and never runs a write tool for a read-only token', async () => {
    const server = guarded(true);
    const run = vi.fn(async () => ({ content: [] }));
    server.registerTool('writes', { annotations: { readOnlyHint: false }, inputSchema: {} }, run);
    const readOnly = authInfoOf({
      userId: 'u',
      role: UserRole.enum.admin,
      scopes: [READ],
      via: PrincipalVia.enum.token,
      tokenId: 't1',
    });

    const result = await registeredTools(server).writes!.handler({}, { authInfo: readOnly });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('insufficient_scope');
    expect(textOf(result)).toContain(WRITE);
    expect(run).not.toHaveBeenCalled();
  });

  it('lets a write token call a read tool (write implies read)', async () => {
    const server = guarded(true);
    server.registerTool('reads', { annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
    const writer = authInfoOf({ ...OWNER_PRINCIPAL, scopes: [WRITE], via: PrincipalVia.enum.token, tokenId: 't2' });
    expect((await registeredTools(server).reads!.handler({ authInfo: writer })).isError).toBeUndefined();
  });

  it('over HTTP, fails closed when no authInfo reached the tool; over stdio, trusts the absence', async () => {
    const http = guarded(true);
    const stdio = guarded(false);
    const run = vi.fn(async () => ({ content: [] }));
    for (const server of [http, stdio]) {
      server.registerTool('writes', { annotations: { readOnlyHint: false }, inputSchema: {} }, run);
    }

    const refused = await registeredTools(http).writes!.handler({}, {});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('unauthenticated');
    expect(run).not.toHaveBeenCalled();

    expect((await registeredTools(stdio).writes!.handler({}, {})).isError).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('authInfoOf', () => {
  it('names a token request pat:<id> and carries the token id — never a secret', () => {
    const info = authInfoOf({
      userId: 'u1',
      role: UserRole.enum.admin,
      scopes: [READ],
      via: PrincipalVia.enum.token,
      tokenId: 'abc',
    });
    expect(info).toEqual({ token: 'abc', clientId: 'pat:abc', scopes: [READ], extra: { userId: 'u1' } });
  });

  it('names a session or owner request by how it authenticated, with every scope', () => {
    expect(authInfoOf(OWNER_PRINCIPAL)).toMatchObject({
      token: 'owner',
      clientId: 'owner',
      scopes: [READ, WRITE],
    });
  });
});

// A reclassification of any tool is a reviewed diff of THESE lists — not a silent drift. Tools read their
// scope from `annotations.readOnlyHint`, the single source (`logic/auth.ts`'s `scopeOfTool`).
const READ_TOOLS = [
  'aggregate_spending',
  'find_correlations',
  'get_account_balances',
  'get_bill',
  'get_budget_status',
  'get_preferences',
  'get_spending_summary',
  'get_status',
  'list_accounts',
  'list_budgets',
  'list_categories',
  'list_credit_cards',
  'list_dashboards',
  'list_exchange_rates',
  'list_recurring',
  'list_sub_categories',
  'list_tags',
  'search_transactions',
];

describe('every registered MCP tool declares its scope', () => {
  const server = buildMcpServer(
    {} as Deps,
    '0.0.0',
    (() => undefined) as unknown as RunEffects,
    (() => undefined) as unknown as RunEffectsSequence,
    () => undefined,
  );
  const scopes = toolScopesOf(server);
  const names = [...scopes.keys()].sort();

  it('registers the whole surface (a tool added without a hint cannot register at all)', () => {
    expect(names).toHaveLength(55);
    for (const [name, tool] of Object.entries(registeredTools(server))) {
      const hint = (tool as unknown as { annotations?: { readOnlyHint?: unknown } }).annotations?.readOnlyHint;
      expect(typeof hint, name).toBe('boolean');
    }
  });

  it('splits read from write exactly as reviewed', () => {
    const readTools = names.filter((name) => scopes.get(name) === READ);
    const writeTools = names.filter((name) => scopes.get(name) === WRITE);
    expect(readTools).toEqual(READ_TOOLS);
    expect(writeTools).toEqual([
      'add_account_expense',
      'add_account_income',
      'add_card_purchase',
      'apply_due_recurring',
      'confirm_transaction',
      'create_account',
      'create_budget',
      'create_category',
      'create_credit_card',
      'create_recurring',
      'create_sub_category',
      'create_tag',
      'create_transfer',
      'delete_account',
      'delete_account_transaction',
      'delete_budget',
      'delete_card_transaction',
      'delete_category',
      'delete_credit_card',
      'delete_dashboard',
      'delete_sub_category',
      'delete_tag',
      'import_account_statement',
      'import_card_statement',
      'pay_bill',
      'rename_dashboard',
      'revert_bill_payment',
      'save_dashboard',
      'set_base_currency',
      'set_exchange_rate',
      'set_exchange_rates',
      'set_locale',
      'update_account',
      'update_account_transaction',
      'update_budget',
      'update_card_transaction',
      'update_credit_card',
    ]);
  });
});
