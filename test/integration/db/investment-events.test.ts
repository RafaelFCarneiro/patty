import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isUniqueConstraintViolation } from '../../../src/diplomat/db/sqlite-errors.js';
import { accounts, assets, investmentEvents } from '../../../src/diplomat/db/schema.js';
import { InvestmentEventType } from '../../../src/models/investment/core.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { buildApp, type AppContext } from '../app-builder.js';

let tmpDir: string;
let ctx: AppContext;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-investment-events-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  await ctx.db.insert(accounts).values({
    id: 'acc-1',
    name: 'Broker',
    type: 'investment',
    currency: 'USD',
    initialBalance: 0,
    userId: OWNER_USER_ID,
  });
  await ctx.db.insert(assets).values({
    id: 'asset-1',
    symbol: 'ZZ',
    exchange: 'ZZX',
    name: 'Zed',
    assetClass: 'stock',
    currency: 'USD',
    pricing: 'market',
  });
});

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const event = (id: string, type: InvestmentEventType) => ({
  id,
  accountId: 'acc-1',
  assetId: 'asset-1',
  type,
  date: '2026-11-01',
  quantity: 1,
  unitCost: 1,
  idempotencyKey: `key-${id}`,
  userId: OWNER_USER_ID,
});

describe('one opening per position, enforced by the database (ADR-038)', () => {
  it('refuses a second opening of the same account and asset with a unique violation', async () => {
    await ctx.db.insert(investmentEvents).values(event('e1', InvestmentEventType.enum.opening));
    const second = ctx.db.insert(investmentEvents).values(event('e2', InvestmentEventType.enum.opening));
    await expect(second).rejects.toSatisfy(isUniqueConstraintViolation);
  });

  it('does not limit the other event types: they are the schema’s room for step 2', async () => {
    await ctx.db.insert(investmentEvents).values(event('e3', InvestmentEventType.enum.buy));
    await ctx.db.insert(investmentEvents).values(event('e4', InvestmentEventType.enum.buy));
    const rows = await ctx.db.select().from(investmentEvents);
    expect(rows.map((row) => row.id).sort()).toEqual(['e1', 'e3', 'e4']);
  });

  it('keeps the conversion state on the account: cash_before_holdings is nullable and starts null', async () => {
    const [row] = await ctx.db.select().from(accounts);
    expect(row?.cashBeforeHoldings).toBeNull();
  });
});
