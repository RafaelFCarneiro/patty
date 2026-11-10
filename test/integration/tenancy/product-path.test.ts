import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../app-builder.js';
import { seedProductPath } from './product-path.js';
import { callTool, errorCodeOf, expectNoLeak, WORLD_A, type Actor } from './world.js';

/**
 * A second user as the product creates one — invited by the owner, the invite claimed, Claude signed in over stdio at
 * `/ui/connect` — acts as that user and only that user. (`isolation.test.ts` runs its whole table of attacks against
 * this same B; these are the facts specific to the way B was made.)
 */

let dir: string;
let ctx: AppContext;
let a: Actor;
let b: Actor;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patty-product-path-'));
  ctx = await buildApp({ dbPath: join(dir, 'test.db'), auth: {} });
  await ctx.app.ready();
  ({ a, b, close } = await seedProductPath(ctx));
});

afterAll(async () => {
  await close?.();
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('B, created through the product path', () => {
  it('exists only as the invite-and-claim flow makes a user: a member with a login of their own', async () => {
    const rows = await ctx.db.all<{
      id: string;
      role: string;
      password_hash: string | null;
      last_login_at: string | null;
    }>(sql`SELECT id, role, password_hash, last_login_at FROM users WHERE username = 'user-b'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: b.world.userId, role: 'member' });
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.last_login_at).not.toBeNull();
    expect(b.world.userId).not.toBe(WORLD_A.userId);
  });

  it('holds a stdio sign-in that belongs to B alone, with the scopes B chose', async () => {
    const signIns = await ctx.db.all<{ user_id: string; scopes: string; client_name: string }>(
      sql`SELECT user_id, scopes, client_name FROM access_tokens WHERE kind = 'stdio'`,
    );
    expect(signIns).toEqual([
      { user_id: b.world.userId, scopes: '["patty:read","patty:write"]', client_name: 'Claude Desktop' },
    ]);
  });

  it('sees only B’s own data through that stdio sign-in', async () => {
    const accounts = await callTool(ctx.app, b, 'list_accounts');
    expect(accounts.failed, accounts.text).toBe(false);
    expect(accounts.text).toContain('ZZ-B Checking');
    expectNoLeak(accounts, WORLD_A, 'list_accounts');

    const transactions = await callTool(ctx.app, b, 'search_transactions');
    expect(transactions.text).toContain('ZZ-B Groceries');
    expectNoLeak(transactions, WORLD_A, 'search_transactions');
  });

  it('writes as B: the new row is B’s, and A’s name is not found', async () => {
    const own = await callTool(ctx.app, b, 'add_account_expense', {
      description: 'ZZ-B coffee',
      amount: 3,
      account: b.world.acc1.name,
    });
    expect(own.failed, own.text).toBe(false);
    expect(await ctx.db.all(sql`SELECT user_id FROM transactions WHERE description = 'ZZ-B coffee'`)).toEqual([
      { user_id: b.world.userId },
    ]);

    const theirs = await callTool(ctx.app, b, 'add_account_expense', {
      description: 'ZZ-B steals',
      amount: 3,
      account: WORLD_A.acc1.name,
    });
    expect(theirs.failed).toBe(true);
    expect(errorCodeOf(theirs)).toBe('unknown_account');
    expect(await ctx.db.all(sql`SELECT 1 FROM transactions WHERE description = 'ZZ-B steals'`)).toEqual([]);
  });

  it('leaves A’s view of the world untouched by B existing', async () => {
    const accounts = await callTool(ctx.app, a, 'list_accounts');
    expect(accounts.text).toContain('ZZ-A Checking');
    expect(accounts.text).not.toContain('ZZ-B');
  });
});
