import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { SESSION_COOKIE_NAME } from '../../../src/diplomat/http/cookies.js';
import { sessions } from '../../../src/diplomat/db/schema.js';
import { authDepsOf } from '../auth/helpers.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { callRoute, callTool, dumpOf, seedTwoUsers, WORLD_A, WORLD_B, type Actor } from './world.js';

/** What makes two users on one instance feel like two instances: dedup, learning, events, preferences, recurring. */

let tmpDir: string;
let ctx: AppContext;
let a: Actor;
let b: Actor;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-tenancy-behaviors-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db'), auth: {} });
  await ctx.app.ready();
  ({ a, b } = await seedTwoUsers(ctx));
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const bodyOf = (outcome: { payload: unknown }) => outcome.payload as Record<string, any>;

describe('the same statement imported by two users', () => {
  // An unattached statement (no account) derives the same idempotency key for the same lines, whoever imports it.
  const STATEMENT = {
    items: [
      { description: 'Padaria da esquina', amount: 12.5, type: 'expense', date: '2026-09-04' },
      { description: 'Farmácia', amount: 40, type: 'expense', date: '2026-09-05' },
    ],
  };

  it('creates the lines for each user, and dedups only within a user', async () => {
    const firstForA = await callTool(ctx.app, a, 'import_account_statement', STATEMENT);
    const firstForB = await callTool(ctx.app, b, 'import_account_statement', STATEMENT);
    const againForA = await callTool(ctx.app, a, 'import_account_statement', STATEMENT);
    const againForB = await callTool(ctx.app, b, 'import_account_statement', STATEMENT);

    for (const outcome of [firstForA, firstForB]) {
      expect(outcome.failed, outcome.text).toBe(false);
      expect(bodyOf(outcome).summary.duplicates).toBe(0);
      expect(bodyOf(outcome).summary.created + bodyOf(outcome).summary.needsReview).toBe(2);
    }
    for (const outcome of [againForA, againForB]) {
      expect(bodyOf(outcome).summary).toMatchObject({ created: 0, needsReview: 0, duplicates: 2 });
    }
    const perUser = await ctx.db.all<{ user_id: string; n: number }>(
      sql`SELECT user_id, COUNT(*) AS n FROM transactions WHERE description IN ('Padaria da esquina', 'Farmácia') GROUP BY user_id ORDER BY user_id`,
    );
    expect(perUser).toEqual([
      { user_id: WORLD_B.userId, n: 2 },
      { user_id: WORLD_A.userId, n: 2 },
    ]);
  });

  it('keeps the derived key unchanged by tenancy: both users’ rows hold the very same key', async () => {
    const keys = await ctx.db.all<{ idempotency_key: string; n: number }>(
      sql`SELECT idempotency_key, COUNT(DISTINCT user_id) AS n FROM transactions WHERE description = 'Farmácia' GROUP BY idempotency_key`,
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.n).toBe(2);
  });
});

describe('what FinTrack has learned is the learner’s own', () => {
  it('classifies by the shared rules and the caller’s own history — never another user’s', async () => {
    // A's merchant edge ("zzashop" → A's own category) exists only for A.
    const forA = await callTool(ctx.app, a, 'add_account_expense', {
      description: 'zzashop weekly',
      amount: 7,
      account: WORLD_A.acc1.name,
    });
    const forB = await callTool(ctx.app, b, 'add_account_expense', {
      description: 'zzashop weekly',
      amount: 7,
      account: WORLD_B.acc1.name,
    });

    expect(JSON.stringify(forA.payload)).toContain('"method":"history"');
    expect(JSON.stringify(forA.payload)).toContain(WORLD_A.category.name);
    expect(JSON.stringify(forB.payload)).not.toContain('"method":"history"');
    expect(JSON.stringify(forB.payload)).not.toContain(WORLD_A.category.name);
  });

  it('applies a shared rule to everyone (seeded merchants classify for both users)', async () => {
    const rule = await ctx.db.get<{ merchant_key: string; category_id: string }>(
      sql`SELECT merchant_key, category_id FROM merchant_category WHERE origin = 'rule' AND category_id = 'cat-food' LIMIT 1`,
    );
    expect(rule).toBeDefined();
    for (const [actor, world] of [
      [a, WORLD_A],
      [b, WORLD_B],
    ] as const) {
      const result = await callTool(ctx.app, actor, 'add_account_expense', {
        description: `${rule!.merchant_key} lunch`,
        amount: 9,
        account: world.acc1.name,
      });
      expect(JSON.stringify(result.payload), world.label).toContain('"method":"rule"');
    }
  });

  it('learns a correction as the corrector’s own history edge, visible to nobody else', async () => {
    const created = await callTool(ctx.app, b, 'add_account_expense', {
      description: 'Zeta Mart',
      amount: 5,
      account: WORLD_B.acc1.name,
    });
    const id = bodyOf(created).transaction.id as string;
    const edgesBefore = await dumpOf(ctx.db, WORLD_A.userId);

    const corrected = await callTool(ctx.app, b, 'update_account_transaction', { id, category: 'cat-food' });
    expect(corrected.failed, corrected.text).toBe(false);

    const edges = await ctx.db.all<{ user_id: string | null; origin: string }>(
      sql`SELECT user_id, origin FROM merchant_category WHERE merchant_key = 'zeta mart'`,
    );
    expect(edges).toEqual([{ user_id: WORLD_B.userId, origin: 'history' }]);
    expect((await dumpOf(ctx.db, WORLD_A.userId))['merchant_category']).toEqual(edgesBefore['merchant_category']);

    // …so it classifies for B next time, and not for A.
    const nextForB = await callTool(ctx.app, b, 'add_account_expense', {
      description: 'Zeta Mart',
      amount: 6,
      account: WORLD_B.acc1.name,
    });
    const nextForA = await callTool(ctx.app, a, 'add_account_expense', {
      description: 'Zeta Mart',
      amount: 6,
      account: WORLD_A.acc1.name,
    });
    expect(JSON.stringify(nextForB.payload)).toContain('"method":"history"');
    expect(JSON.stringify(nextForA.payload)).not.toContain('"method":"history"');
  });

  it('lists only the caller’s merchants in the top-merchants resource', async () => {
    const forA = await callTool(ctx.app, a, 'aggregate_spending', { groupBy: 'merchant', month: 9, year: 2026 });
    const forB = await callTool(ctx.app, b, 'aggregate_spending', { groupBy: 'merchant', month: 10, year: 2026 });
    expect(JSON.stringify(forA.payload)).not.toContain('zeta mart');
    expect(JSON.stringify(forB.payload)).not.toContain(WORLD_A.category.name);
  });
});

describe('language and base currency are each person’s own', () => {
  const prefs = async (actor: Actor) => bodyOf(await callTool(ctx.app, actor, 'get_preferences'));

  it('starts from each user’s own row', async () => {
    expect(await prefs(a)).toEqual({ locale: 'pt', localeSource: 'explicit', baseCurrency: 'BRL' });
    expect(await prefs(b)).toEqual({ locale: 'es', localeSource: 'explicit', baseCurrency: 'USDC' });
  });

  it('changes one user’s without touching the other’s, over MCP and REST alike', async () => {
    expect((await callTool(ctx.app, b, 'set_locale', { locale: 'en', source: 'explicit' })).failed).toBe(false);
    expect((await callTool(ctx.app, b, 'set_base_currency', { baseCurrency: 'BTC' })).failed).toBe(false);
    expect(await prefs(b)).toEqual({ locale: 'en', localeSource: 'explicit', baseCurrency: 'BTC' });
    expect(await prefs(a)).toEqual({ locale: 'pt', localeSource: 'explicit', baseCurrency: 'BRL' });

    expect((await callRoute(ctx.app, a, 'POST', '/api/settings/base-currency', { baseCurrency: 'USD' })).failed).toBe(
      false,
    );
    expect(bodyOf(await callRoute(ctx.app, a, 'GET', '/api/preferences')).baseCurrency).toBe('USD');
    expect(bodyOf(await callRoute(ctx.app, b, 'GET', '/api/preferences')).baseCurrency).toBe('BTC');
  });

  it('shows each user the default categories in their own language, from one shared row', async () => {
    const seenByA = await callTool(ctx.app, a, 'list_categories');
    const seenByB = await callTool(ctx.app, b, 'list_categories');
    expect(seenByA.text).toContain('Alimentação'); // pt
    expect(seenByB.text).toContain('Food'); // en, since B switched above
    expect(seenByA.text).not.toContain('"name": "Food"');
  });

  it('forgets nothing it should remember and nothing it should not: the cache is per user', async () => {
    expect((await prefs(b)).locale).toBe('en');
    expect((await prefs(a)).locale).toBe('pt');
  });
});

describe('apply_due_recurring applies only the caller’s rules', () => {
  const nextDueOf = async (id: string) =>
    (await ctx.db.get<{ next_due: string }>(sql`SELECT next_due FROM recurring_rules WHERE id = ${id}`))?.next_due;
  const ruleTransactions = (userId: string) =>
    ctx.db.all<{ description: string; user_id: string }>(
      sql`SELECT description, user_id FROM transactions WHERE idempotency_key LIKE 'rec-%' AND user_id = ${userId} ORDER BY date`,
    );

  it('materializes A’s due rule for A alone, and leaves B’s rule due', async () => {
    const result = await callTool(ctx.app, a, 'apply_due_recurring', { through: '2026-10-13' });

    expect(result.failed, result.text).toBe(false);
    const applied = bodyOf(result).applied as Array<{ rule: string }>;
    expect(applied.length).toBeGreaterThan(0);
    expect(new Set(applied.map((entry) => entry.rule))).toEqual(new Set([WORLD_A.recurring.description]));
    expect(await nextDueOf(WORLD_A.recurring.id)).not.toBe('2026-09-01');
    expect(await nextDueOf(WORLD_B.recurring.id)).toBe('2026-09-01'); // untouched
    expect((await ruleTransactions(WORLD_B.userId)).length).toBe(0);
    expect(
      (await ruleTransactions(WORLD_A.userId)).every((row) => row.description === WORLD_A.recurring.description),
    ).toBe(true);
  });

  it('then B’s call applies B’s, and does not apply A’s again', async () => {
    const aRowsBefore = (await ruleTransactions(WORLD_A.userId)).length;

    const result = await callRoute(ctx.app, b, 'POST', '/api/recurring/apply-due', { through: '2026-10-13' });

    expect(result.failed, result.text).toBe(false);
    const applied = bodyOf(result).applied as Array<{ rule: string }>;
    expect(new Set(applied.map((entry) => entry.rule))).toEqual(new Set([WORLD_B.recurring.description]));
    expect(await nextDueOf(WORLD_B.recurring.id)).not.toBe('2026-09-01');
    expect((await ruleTransactions(WORLD_A.userId)).length).toBe(aRowsBefore);
  });
});

describe('who hears about a change (the change bus and /ui/events)', () => {
  const SESSION_TOKENS = {
    A: 'sess-token-A-0123456789abcdef0123456789abcdef',
    B: 'sess-token-B-0123456789abcdef0123456789abcdef',
  };

  const openStream = async (baseUrl: string, label: 'A' | 'B', controller: AbortController) => {
    const res = await fetch(`${baseUrl}/ui/events`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKENS[label]}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    return res.body!.getReader();
  };

  const collect = (reader: ReadableStreamDefaultReader<Uint8Array>): { received: () => string } => {
    const decoder = new TextDecoder();
    let received = '';
    void (async () => {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (next.done) return;
        received += decoder.decode(next.value, { stream: true });
      }
    })();
    return { received: () => received };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  it('delivers a change to its own user’s stream only', async () => {
    const baseUrl = await (async () => {
      if (!ctx.app.server.listening) await ctx.app.listen({ port: 0, host: LOOPBACK_HOST });
      return `http://${LOOPBACK_HOST}:${(ctx.app.server.address() as AddressInfo).port}`;
    })();
    const deps = authDepsOf(ctx);
    for (const [label, world] of [
      ['A', WORLD_A],
      ['B', WORLD_B],
    ] as const) {
      await ctx.db.insert(sessions).values({
        id: `sess-${label}`,
        userId: world.userId,
        tokenHash: deps.secrets.hashSecret(SESSION_TOKENS[label]),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const heardA = collect(await openStream(baseUrl, 'A', controllerA));
    const heardB = collect(await openStream(baseUrl, 'B', controllerB));

    // A writes: A's browser hears, B's does not.
    await callTool(ctx.app, a, 'create_tag', { name: 'only-for-a' });
    await settle();
    expect(heardA.received()).toContain('"entities":["tag"]');
    expect(heardB.received()).not.toContain('tag');

    // …and the other way round.
    const budget = await callTool(ctx.app, b, 'create_budget', { category: 'Food', currency: 'BTC', limit: 1 });
    expect(budget.failed, budget.text).toBe(false);
    await settle();
    expect(heardB.received()).toContain('"entities":["budget"]');
    expect(heardA.received()).not.toContain('budget');

    // …but a shared exchange rate moves everyone's valuations, so B refreshing one reaches A's stream too.
    await callTool(ctx.app, b, 'set_exchange_rate', {
      from: 'USD',
      to: 'BRL',
      rate: 5.5,
      asOf: '2026-10-16T00:00:00.000Z',
    });
    await settle();
    expect(heardA.received()).toContain('"entities":["currency_rate"]');

    controllerA.abort();
    controllerB.abort();
  });
});

describe('a user is told "not found" about another user’s ids and names, never "forbidden"', () => {
  it('answers the same for an id that belongs to another user as for one that never existed', async () => {
    const theirs = await callTool(ctx.app, b, 'delete_account_transaction', { id: WORLD_A.tx.expense, confirm: true });
    const nobodys = await callTool(ctx.app, b, 'delete_account_transaction', {
      id: 'tx-nobody-has-this',
      confirm: true,
    });

    expect(theirs.failed).toBe(true);
    expect(bodyOf(theirs).error.code).toBe('unknown_transaction');
    expect({ ...bodyOf(theirs).error, id: undefined }).toEqual({ ...bodyOf(nobodys).error, id: undefined });
    expect(JSON.stringify(theirs.payload)).not.toMatch(/forbidden|permission|not allowed|belongs to/i);
  });

  it('answers the same for a name that belongs to another user as for one that never existed', async () => {
    const theirs = await callTool(ctx.app, b, 'get_bill', { card: WORLD_A.card.name, month: 9, year: 2026 });
    const nobodys = await callTool(ctx.app, b, 'get_bill', { card: 'No Such Card', month: 9, year: 2026 });

    expect(bodyOf(theirs).error.code).toBe(bodyOf(nobodys).error.code);
    expect(bodyOf(theirs).error.candidates).toEqual(bodyOf(nobodys).error.candidates);
    expect(bodyOf(theirs).error.candidates).not.toContain(WORLD_A.card.name);
  });
});
