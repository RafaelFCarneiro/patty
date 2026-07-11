import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, callToolError, deleteTransactions, ensure, makeClient } from './helpers.js';

// ADR-014: keyset pagination + whitelisted ordering for search_transactions.

type TxView = { id: string; date: string; amount: number; description: string };
type Page = { items: TxView[]; nextCursor?: string; total?: number };

describe('MCP integration > search_transactions pagination (ADR-014)', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  const stamp = Date.now();
  const marker = `Pager ${stamp}`;
  const accountName = `Pager Account ${stamp}`;
  const createdTxIds: string[] = [];

  // 12 dates × 10 rows/date = 120 rows, so a small page size lands page boundaries in the middle
  // of a same-date cluster — the case that actually exercises the tiebreaker.
  const DATE_GROUPS = 12;
  const ROWS_PER_DATE = 10;
  const TOTAL_ROWS = DATE_GROUPS * ROWS_PER_DATE;

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);

    await callTool(client, {
      name: 'create_account',
      args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
    });

    const items = [];
    let amount = 1;
    for (let g = 0; g < DATE_GROUPS; g++) {
      const date = `2031-${String(g + 1).padStart(2, '0')}-15`;
      for (let r = 0; r < ROWS_PER_DATE; r++) {
        items.push({
          description: `${marker} ${g}-${r}`,
          amount,
          type: 'expense' as const,
          date,
          idempotencyKey: `pager-${stamp}-${g}-${r}`,
        });
        amount += 1;
      }
    }

    const result = (await callTool(client, {
      name: 'import_account_statement',
      args: { account: accountName, items },
    })) as { items: Array<{ transaction?: { id?: string } }> };
    for (const item of result.items) {
      if (item.transaction?.id) createdTxIds.push(item.transaction.id);
    }
    expect(createdTxIds.length).toBe(TOTAL_ROWS);
  });

  afterAll(async () => {
    await transport.close();
    await deleteTransactions(createdTxIds);
  });

  const search = (args: Record<string, unknown>) =>
    callTool(client, { name: 'search_transactions', args: { text: marker, ...args } }) as Promise<Page>;

  it('walks the full result set via nextCursor with no gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await search({ limit: 7, cursor });
      expect(page.items.length).toBeLessThanOrEqual(7);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(50); // guard against an infinite loop on a real bug
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(seen.length).toBe(TOTAL_ROWS);
    expect(new Set(seen).size).toBe(TOTAL_ROWS); // no duplicates
    for (const id of createdTxIds) expect(seen).toContain(id);
  });

  it('sorts by amount ascending across a page boundary with no gaps or duplicates', async () => {
    const seen: TxView[] = [];
    let cursor: string | undefined;
    do {
      const page = await search({ limit: 11, cursor, sort: 'amount', dir: 'asc' });
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.length).toBe(TOTAL_ROWS);
    const amounts = seen.map((t) => t.amount);
    const sorted = [...amounts].sort((a, b) => a - b);
    expect(amounts).toEqual(sorted);
  });

  it('sorts by amount descending across a page boundary with no gaps or duplicates', async () => {
    const seen: TxView[] = [];
    let cursor: string | undefined;
    do {
      const page = await search({ limit: 11, cursor, sort: 'amount', dir: 'desc' });
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.length).toBe(TOTAL_ROWS);
    const amounts = seen.map((t) => t.amount);
    const sorted = [...amounts].sort((a, b) => b - a);
    expect(amounts).toEqual(sorted);
  });

  it('last page has no nextCursor', async () => {
    const page = await search({ limit: 200 });
    expect(page.items.length).toBe(TOTAL_ROWS);
    expect(page.nextCursor).toBeUndefined();
  });

  it('includeTotal returns the filter-matching count on any page; absent otherwise', async () => {
    const first = await search({ limit: 5, includeTotal: true });
    expect(first.total).toBe(TOTAL_ROWS);
    ensure(first.nextCursor, 'expected a nextCursor for such a small page size');

    const second = await search({ limit: 5, cursor: first.nextCursor, includeTotal: true });
    expect(second.total).toBe(TOTAL_ROWS);

    const noTotal = await search({ limit: 5 });
    expect(noTotal.total).toBeUndefined();
  });

  it('rejects a follow-up page whose sort/dir does not match the cursor', async () => {
    const first = await search({ limit: 5, sort: 'date', dir: 'desc' });
    ensure(first.nextCursor, 'expected a nextCursor');

    const wrongSort = (await callToolError(client, {
      name: 'search_transactions',
      args: { text: marker, cursor: first.nextCursor, sort: 'amount', dir: 'desc' },
    })) as { error?: { code?: string } };
    expect(wrongSort.error?.code).toBe('validation');

    const wrongDir = (await callToolError(client, {
      name: 'search_transactions',
      args: { text: marker, cursor: first.nextCursor, sort: 'date', dir: 'asc' },
    })) as { error?: { code?: string } };
    expect(wrongDir.error?.code).toBe('validation');
  });

  it('rejects a malformed cursor', async () => {
    const result = (await callToolError(client, {
      name: 'search_transactions',
      args: { text: marker, cursor: 'not-a-real-cursor' },
    })) as { error?: { code?: string } };
    expect(result.error?.code).toBe('validation');
  });

  it('filters still narrow results while paginating', async () => {
    // Date range instead of text: FTS5 tokenizes on '-', so a text filter like "0-" would match
    // any description containing the bare token "0" (e.g. group 10's "10-0") — not what this test
    // means to isolate. A date-range filter narrows to exactly one group unambiguously.
    const page = await search({ limit: 200, from: '2031-01-15', to: '2031-01-16' });
    expect(page.items.length).toBe(ROWS_PER_DATE);
    expect(page.items.every((t) => t.date === '2031-01-15')).toBe(true);
  });
});
