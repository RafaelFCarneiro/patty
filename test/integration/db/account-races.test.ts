import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as accountAdapters from '../../../src/adapters/accounts.js';
import * as investmentAdapters from '../../../src/adapters/investment-events.js';
import { getAccountBalances, updateAccount } from '../../../src/controllers/account/account.js';
import type { Deps, Scoped } from '../../../src/controllers/deps.js';
import { deleteInvestmentEvent, openPosition } from '../../../src/controllers/investment/events.js';
import { accounts, assetPrices, assets } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { buildApp, type AppContext } from '../app-builder.js';

let tmpDir: string;
let ctx: AppContext;
let scoped: Scoped;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-account-races-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  scoped = ctx.scopedAs({ userId: OWNER_USER_ID });
  await ctx.db.insert(assets).values({
    id: 'asset-a',
    symbol: 'AAA',
    exchange: 'ZZX',
    name: 'Aaa',
    assetClass: 'stock',
    currency: 'USD',
    pricing: 'market',
  });
  await ctx.db.insert(assetPrices).values({
    id: 'price-a',
    assetId: 'asset-a',
    price: 500,
    asOf: new Date().toISOString(),
    source: null,
  });
});

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const createBroker = (id: string, name: string, initialBalance: number) =>
  ctx.db.insert(accounts).values({
    id,
    name,
    type: 'investment',
    currency: 'USD',
    initialBalance,
    userId: OWNER_USER_ID,
  });

const open = (deps: Deps, account: string, remainingCash: number) =>
  scoped.runEffects(() =>
    openPosition(deps, { account, asset: 'AAA', quantity: 1, avgCost: 500, remainingCash })
      .map(accountAdapters.outcomeToDb)
      .map(investmentAdapters.outcomeToDb),
  );

const remove = (deps: Deps, id: string) =>
  scoped.runEffects(() =>
    deleteInvestmentEvent(deps, { id }).map(accountAdapters.outcomeToDb).map(investmentAdapters.outcomeToDb),
  );

describe('updateAccount reads the versioned account before it counts references (ADR-038 §7)', () => {
  it('an opening landing after the count conflicts with the update; the retry refuses the change', async () => {
    await createBroker('acc-u-1', 'Broker U1', 500);
    const racing: Deps = {
      ...scoped.deps,
      accounts: {
        ...scoped.deps.accounts,
        countReferences: async (id) => {
          const counted = await scoped.deps.accounts.countReferences(id);
          if (counted.investmentEvents === 0 && !opened) {
            opened = true;
            (await open(scoped.deps, 'Broker U1', 0))._unsafeUnwrap();
          }
          return counted;
        },
      },
    };
    let opened = false;

    const result = await scoped.runEffects(() =>
      updateAccount(racing, { name: 'Broker U1', currency: 'BTC' }).map(accountAdapters.outcomeToDb),
    );

    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'validation' });
    expect((await scoped.deps.accounts.findByName('Broker U1'))?.currency).toBe('USD');
    expect(await scoped.deps.investments.list({ accountId: 'acc-u-1' })).toHaveLength(1);
  });
});

describe('get_account_balances reads cash and holdings from one account version (ADR-038 §6)', () => {
  it('an opening that lands between the cash read and the events read does not count the cash twice', async () => {
    await createBroker('acc-s-1', 'Broker S1', 500);
    let raced = false;
    const racing: Deps = {
      ...scoped.deps,
      investments: {
        ...scoped.deps.investments,
        list: async (filter) => {
          if (!raced) {
            raced = true;
            (await open(scoped.deps, 'Broker S1', 0))._unsafeUnwrap();
          }
          return scoped.deps.investments.list(filter);
        },
      },
    };

    const result = (await getAccountBalances(racing, { account: 'Broker S1' }))._unsafeUnwrap();

    expect(result.balances[0]).toMatchObject({
      balance: 0,
      holdings: { cashBalance: 0, holdingsValue: 500, total: 500 },
    });
    expect(result.consolidatedNetWorth.total).toBe(500);
  });

  it('a last deletion between the two reads reports neither the old cash nor stale holdings', async () => {
    await createBroker('acc-s-2', 'Broker S2', 700);
    const opened = (await open(scoped.deps, 'Broker S2', 85))._unsafeUnwrap();
    let raced = false;
    const racing: Deps = {
      ...scoped.deps,
      investments: {
        ...scoped.deps.investments,
        list: async (filter) => {
          if (!raced) {
            raced = true;
            (await remove(scoped.deps, opened.id))._unsafeUnwrap();
          }
          return scoped.deps.investments.list(filter);
        },
      },
    };

    const result = (await getAccountBalances(racing, { account: 'Broker S2' }))._unsafeUnwrap();

    expect(result.balances[0]!.balance).toBe(700);
    expect(result.balances[0]!.holdings).toBeUndefined();
    expect(result.consolidatedNetWorth.total).toBe(700);
  });

  it('answers from one version when nothing races, reading each investment account twice', async () => {
    await createBroker('acc-s-3', 'Broker S3', 40);
    let reads = 0;
    const counting: Deps = {
      ...scoped.deps,
      accounts: {
        ...scoped.deps.accounts,
        findRawById: async (id) => {
          reads += 1;
          return scoped.deps.accounts.findRawById(id);
        },
      },
    };

    const result = (await getAccountBalances(counting, { account: 'Broker S3' }))._unsafeUnwrap();

    expect(result.balances[0]).toMatchObject({ balance: 40 });
    expect(reads).toBe(2);
  });
});
