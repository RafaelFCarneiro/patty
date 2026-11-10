import type { AddressInfo } from 'node:net';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { Db } from '../../../src/diplomat/db/driver.js';
import {
  accounts,
  accessTokens,
  bills,
  budgets,
  categories,
  creditCards,
  dashboards,
  merchantCategory,
  merchants,
  recurringRules,
  tags,
  transactionTags,
  transactions,
  userSettings,
  users,
} from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { ALL_SCOPES } from '../../../src/models/auth/scope.js';
import type { AppContext } from '../app-builder.js';
import { authDepsOf, bearer, INITIALIZE_REQUEST, MCP_HEADERS, toolCall } from '../auth/helpers.js';

/**
 * Two users with full sets of their own data, inserted straight into the database (no product path creates a second
 * user yet). Everything of user X carries X's label in its name and id, so a leak is a substring match away.
 */
export type World = {
  label: 'A' | 'B';
  userId: string;
  username: string;
  // names (what a person types) and ids (what a tool returns)
  acc1: { id: string; name: string };
  acc2: { id: string; name: string };
  cardAccount: { id: string; name: string };
  card: { id: string; name: string };
  bill: { id: string; month: number; year: number };
  tx: { expense: string; income: string; cardPurchase: string; pending: string };
  tag: { id: string; name: string };
  budget: { id: string };
  recurring: { id: string; description: string };
  category: { id: string; name: string };
  subCategory: { id: string; name: string };
  subUnderDefault: { id: string; name: string };
  merchantKey: string;
  dashboard: { id: string; name: string };
  locale: 'en' | 'es' | 'pt';
  baseCurrency: 'USD' | 'BRL' | 'USDC' | null;
};

export const worldOf = (label: 'A' | 'B', userId: string): World => {
  const lower = label.toLowerCase();
  return {
    label,
    userId,
    username: `user-${lower}`,
    acc1: { id: `acc-${label}-1`, name: `ZZ-${label} Checking` },
    acc2: { id: `acc-${label}-2`, name: `ZZ-${label} Savings` },
    cardAccount: { id: `acc-${label}-card`, name: `Card: ZZ-${label} Visa` },
    card: { id: `card-${label}`, name: `ZZ-${label} Visa` },
    bill: { id: `bill-${label}`, month: 9, year: 2026 },
    tx: {
      expense: `tx-${label}-expense`,
      income: `tx-${label}-income`,
      cardPurchase: `tx-${label}-card`,
      pending: `tx-${label}-pending`,
    },
    tag: { id: `tag-${label}`, name: `zz-${lower}-tag` },
    budget: { id: `bud-${label}` },
    recurring: { id: `rec-${label}`, description: `ZZ-${label} Rent` },
    category: { id: `cat-${label}-own`, name: `ZZ-${label} Pets` },
    subCategory: { id: `sub-${label}-own`, name: `ZZ-${label} Vet` },
    subUnderDefault: { id: `sub-${label}-food`, name: `ZZ-${label} Takeaway` },
    merchantKey: `zz${lower}shop`,
    dashboard: { id: `dash-${label}`, name: `zz-${lower}-board` },
    locale: label === 'A' ? 'pt' : 'es',
    baseCurrency: label === 'A' ? null : 'USDC',
  };
};

export const WORLD_A = worldOf('A', OWNER_USER_ID);
export const WORLD_B = worldOf('B', 'user-bob');

/** Every string that identifies one of `world`'s rows — a response that mentions any of them leaked it. */
export const markersOf = (world: World): string[] => {
  const lower = world.label.toLowerCase();
  return [
    `ZZ-${world.label}`,
    `zz-${lower}-`,
    `zz${lower}shop`,
    `-${world.label}-`,
    `-${world.label}"`,
    world.bill.id,
    world.card.id,
    world.tag.id,
    world.budget.id,
    world.recurring.id,
    world.dashboard.id,
  ];
};

const NOW = '2026-10-01T00:00:00.000Z';

/** Inserts the whole of one user's data. Dates sit in September 2026; the recurring rule is already due. */
export const seedWorld = async (db: Db, w: World): Promise<void> => {
  const owner = { userId: w.userId };
  await db.insert(accounts).values([
    { ...owner, id: w.acc1.id, name: w.acc1.name, type: 'checking', initialBalance: 1000, currency: 'USD' },
    { ...owner, id: w.acc2.id, name: w.acc2.name, type: 'savings', initialBalance: 200, currency: 'BRL' },
    { ...owner, id: w.cardAccount.id, name: w.cardAccount.name, type: 'credit', initialBalance: 0, currency: 'USD' },
  ]);
  await db.insert(creditCards).values({
    ...owner,
    id: w.card.id,
    name: w.card.name,
    closingDay: 10,
    dueDay: 20,
    currency: 'USD',
    accountId: w.cardAccount.id,
    paymentAccountId: w.acc1.id,
  });
  await db.insert(bills).values({
    ...owner,
    id: w.bill.id,
    creditCardId: w.card.id,
    month: w.bill.month,
    year: w.bill.year,
    closeDate: '2026-09-10',
    dueDate: '2026-09-20',
    status: 'open',
  });
  await db.insert(categories).values([
    { ...owner, id: w.category.id, name: w.category.name, kind: 'expense' },
    { ...owner, id: w.subCategory.id, name: w.subCategory.name, kind: 'expense', parentId: w.category.id },
    { ...owner, id: w.subUnderDefault.id, name: w.subUnderDefault.name, kind: 'expense', parentId: 'cat-food' },
  ]);
  await db.insert(merchants).values({ key: w.merchantKey }).onConflictDoNothing();
  await db.insert(merchantCategory).values({
    merchantKey: w.merchantKey,
    categoryId: w.category.id,
    weight: 4,
    origin: 'history',
    userId: w.userId,
  });
  await db.insert(tags).values({ ...owner, id: w.tag.id, name: w.tag.name });
  const base = {
    ...owner,
    source: 'mcp' as const,
    classificationMethod: 'user' as const,
    confidence: 1,
  };
  await db.insert(transactions).values([
    {
      ...base,
      id: w.tx.expense,
      description: `ZZ-${w.label} Groceries`,
      amount: 50,
      type: 'expense',
      status: 'effective',
      date: '2026-09-01',
      currency: 'USD',
      idempotencyKey: `key-${w.label}-1`,
      fromAccountId: w.acc1.id,
      categoryId: 'cat-food',
    },
    {
      ...base,
      id: w.tx.income,
      description: `ZZ-${w.label} Salary`,
      amount: 2000,
      type: 'income',
      status: 'effective',
      date: '2026-09-02',
      currency: 'BRL',
      idempotencyKey: `key-${w.label}-2`,
      fromAccountId: w.acc2.id,
    },
    {
      ...base,
      id: w.tx.cardPurchase,
      description: `ZZ-${w.label} Laptop`,
      amount: 300,
      type: 'expense',
      status: 'effective',
      date: '2026-09-03',
      currency: 'USD',
      idempotencyKey: `key-${w.label}-3`,
      fromAccountId: w.cardAccount.id,
      creditCardId: w.card.id,
      billId: w.bill.id,
    },
    {
      ...base,
      id: w.tx.pending,
      description: `ZZ-${w.label} Pending`,
      amount: 20,
      type: 'expense',
      status: 'pending',
      date: '2027-01-01',
      currency: 'USD',
      idempotencyKey: `key-${w.label}-4`,
      fromAccountId: w.acc1.id,
    },
  ]);
  await db.insert(transactionTags).values({ transactionId: w.tx.expense, tagId: w.tag.id });
  await db.insert(budgets).values({
    ...owner,
    id: w.budget.id,
    categoryId: 'cat-food',
    currency: 'USD',
    limitAmount: 500,
    period: 'monthly',
  });
  await db.insert(recurringRules).values({
    ...owner,
    id: w.recurring.id,
    description: w.recurring.description,
    amount: 900,
    type: 'expense',
    period: 'monthly',
    nextDue: '2026-09-01',
    currency: 'USD',
    accountId: w.acc1.id,
  });
  await db.insert(dashboards).values({
    id: w.dashboard.id,
    name: w.dashboard.name,
    html: `<section>ZZ-${w.label} private dashboard</section>`,
    source: 'inline',
    path: null,
    updatedAt: NOW,
    userId: w.userId,
  });
  await db.insert(userSettings).values({
    userId: w.userId,
    locale: w.locale,
    localeSource: 'explicit',
    baseCurrency: w.baseCurrency,
  });
};

export type Actor = {
  world: World;
  token: string;
  /** How this actor calls an MCP tool when not over HTTP with its bearer token — a stdio sign-in, say. */
  call?: (name: string, args: Record<string, unknown>) => Promise<Outcome>;
};

export const mintTokenFor = async (ctx: AppContext, world: World): Promise<string> => {
  const token = `ptk_${world.label}${'x'.repeat(40)}`;
  await ctx.db.insert(accessTokens).values({
    id: `pat-${world.label}`,
    userId: world.userId,
    kind: 'pat',
    name: `${world.label}'s token`,
    tokenHash: authDepsOf(ctx).secrets.hashSecret(token),
    prefix: token.slice(0, 10),
    scopes: [...ALL_SCOPES],
    createdAt: NOW,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return token;
};

/** A (the owner) and B (a second user), claimed so that tokens work, each with a full world and a bearer token. */
export const seedTwoUsers = async (ctx: AppContext): Promise<{ a: Actor; b: Actor }> => {
  const { db } = ctx;
  await db
    .update(users)
    .set({ username: WORLD_A.username, passwordHash: 'not-a-password' })
    .where(eq(users.id, WORLD_A.userId));
  await db.insert(users).values({
    id: WORLD_B.userId,
    username: WORLD_B.username,
    passwordHash: 'not-a-password',
    role: 'member',
    createdAt: NOW,
  });
  await seedWorld(db, WORLD_A);
  await seedWorld(db, WORLD_B);
  return {
    a: { world: WORLD_A, token: await mintTokenFor(ctx, WORLD_A) },
    b: { world: WORLD_B, token: await mintTokenFor(ctx, WORLD_B) },
  };
};

// ─── dumps: everything that belongs to one user, and everything shared ───

type Row = Record<string, unknown>;
const sorted = (rows: Row[]): Row[] => rows.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

const rowsOf = async (db: Db, query: ReturnType<typeof sql>): Promise<Row[]> => sorted(await db.all<Row>(query));

/** Every row that is `userId`'s, in every table that has owners. */
export const dumpOf = async (db: Db, userId: string): Promise<Record<string, Row[]>> => {
  const dump: Record<string, Row[]> = {};
  for (const table of [
    'accounts',
    'credit_cards',
    'bills',
    'transactions',
    'tags',
    'budgets',
    'recurring_rules',
    'categories',
    'merchant_category',
    'dashboards',
    'user_settings',
  ])
    dump[table] = await rowsOf(db, sql`SELECT * FROM ${sql.identifier(table)} WHERE user_id = ${userId}`);
  dump['transaction_tags'] = await rowsOf(
    db,
    sql`SELECT tt.* FROM transaction_tags tt JOIN transactions t ON t.id = tt.transaction_id WHERE t.user_id = ${userId}`,
  );
  return dump;
};

/** The shared defaults: seeded categories, `rule` merchant edges, bundled dashboards. */
export const sharedDump = async (db: Db): Promise<Record<string, Row[]>> => ({
  categories: await rowsOf(db, sql`SELECT * FROM categories WHERE user_id IS NULL`),
  merchant_category: await rowsOf(db, sql`SELECT * FROM merchant_category WHERE user_id IS NULL`),
  dashboards: await rowsOf(db, sql`SELECT * FROM dashboards WHERE user_id IS NULL`),
});

export const countOwned = async (
  db: Db,
  table: typeof transactions | typeof accounts,
  userId: string,
): Promise<number> => {
  const rows = await db
    .select()
    .from(table)
    .where(and(eq(table.userId, userId)));
  return rows.length;
};

export const sharedCategoryCount = async (db: Db): Promise<number> =>
  (await db.select().from(categories).where(isNull(categories.userId))).length;

// ─── calling the product as an actor ───

export type Outcome = { failed: boolean; status: number; payload: unknown; text: string };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A tool call over `POST /mcp` with the actor's bearer token: the edge, the gate and the tool, for real. */
/** `POST /mcp` over a real loopback socket. The MCP SDK's transport drains the request body on a timer against the
 *  socket; light-my-request's fake one has no `destroySoon`, so `inject` would leave uncaught errors behind. */
export const postMcp = async (
  app: FastifyInstance,
  actor: Actor,
  payload: unknown,
): Promise<{ status: number; json: any }> => {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...bearer(actor.token) },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
};

export const callTool = async (
  app: FastifyInstance,
  actor: Actor,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Outcome> => {
  if (actor.call) return actor.call(name, args);
  const res = await postMcp(app, actor, toolCall(name, args));
  const message = res.json as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: { message?: string };
  };
  const text = message.result?.content?.[0]?.text ?? message.error?.message ?? JSON.stringify(res.json);
  return {
    failed: message.result?.isError === true || message.error !== undefined,
    status: res.status,
    payload: parseJson(text),
    text,
  };
};

export const readResource = async (app: FastifyInstance, actor: Actor, uri: string): Promise<Outcome> => {
  const res = await postMcp(app, actor, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri } });
  const message = res.json as { result?: { contents?: Array<{ text?: string }> }; error?: { message?: string } };
  const text = message.result?.contents?.[0]?.text ?? message.error?.message ?? JSON.stringify(res.json);
  return { failed: message.error !== undefined, status: res.status, payload: parseJson(text), text };
};

export const callRoute = async (
  app: FastifyInstance,
  actor: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<Outcome> => {
  const res = await app.inject({
    method,
    url,
    headers: bearer(actor.token),
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { failed: res.statusCode >= 400, status: res.statusCode, payload: parseJson(res.body), text: res.body };
};

/** A response's text with what the caller itself sent removed: a not-found error echoes the name asked for, which is
 *  the caller's own input, not a leak. */
export const withoutEcho = (outcome: Outcome): string => {
  const payload = outcome.payload as { error?: Record<string, unknown> } | undefined;
  if (payload === null || typeof payload !== 'object' || payload.error === undefined) return JSON.stringify(payload);
  // An error names what the caller asked for (`query`, `name`, `id`): that is the caller's own input, not a leak.
  const { query: _query, name: _name, id: _id, ...rest } = payload.error;
  return JSON.stringify({ ...payload, error: rest });
};

export const errorCodeOf = (outcome: Outcome): string | undefined => {
  const payload = outcome.payload as { error?: { code?: string } } | undefined;
  return payload?.error?.code;
};

export const expectNoLeak = (outcome: Outcome, of: World, context: string): void => {
  const scanned = withoutEcho(outcome);
  const leaked = markersOf(of).filter((marker) => scanned.includes(marker));
  expect(leaked, `${context} leaked ${of.label}'s data: ${scanned.slice(0, 400)}`).toEqual([]);
};

export { INITIALIZE_REQUEST };
