import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
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
});

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const insertPosition = async (name: string) => {
  const accountId = `acc-${name}`;
  const assetId = `asset-${name}`;
  await ctx.db.insert(accounts).values({
    id: accountId,
    name: `Broker ${name}`,
    type: 'investment',
    currency: 'USD',
    initialBalance: 0,
    userId: OWNER_USER_ID,
  });
  await ctx.db.insert(assets).values({
    id: assetId,
    symbol: name.toUpperCase(),
    exchange: 'ZZX',
    name,
    assetClass: 'stock',
    currency: 'USD',
    pricing: 'market',
  });
  return (id: string, type: InvestmentEventType) => ({
    id,
    accountId,
    assetId,
    type,
    date: '2026-11-01',
    quantity: 1,
    unitCost: 1,
    idempotencyKey: `key-${id}`,
    userId: OWNER_USER_ID,
  });
};

describe('one opening per position, enforced by the database (Feature Design 023)', () => {
  it('refuses a second opening of the same account and asset with a unique violation', async () => {
    const event = await insertPosition('dup');
    await ctx.db.insert(investmentEvents).values(event('dup-1', InvestmentEventType.enum.opening));
    const second = ctx.db.insert(investmentEvents).values(event('dup-2', InvestmentEventType.enum.opening));
    await expect(second).rejects.toSatisfy(isUniqueConstraintViolation);
  });

  it('does not limit the other event types: they are the schema’s room for step 2', async () => {
    const event = await insertPosition('buys');
    await ctx.db.insert(investmentEvents).values(event('buys-1', InvestmentEventType.enum.buy));
    await ctx.db.insert(investmentEvents).values(event('buys-2', InvestmentEventType.enum.buy));
    const rows = await ctx.db.select().from(investmentEvents).where(eq(investmentEvents.accountId, 'acc-buys'));
    expect(rows.map((row) => row.id).sort()).toEqual(['buys-1', 'buys-2']);
  });

  it('keeps the conversion state on the account: cash_before_holdings is nullable and starts null', async () => {
    await insertPosition('state');
    const [row] = await ctx.db.select().from(accounts).where(eq(accounts.id, 'acc-state'));
    expect(row?.cashBeforeHoldings).toBeNull();
  });
});
