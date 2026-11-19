import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as accountAdapters from '../../../src/adapters/accounts.js';
import * as investmentAdapters from '../../../src/adapters/investment-events.js';
import { updateAccount } from '../../../src/controllers/account/account.js';
import type { Deps, Scoped } from '../../../src/controllers/deps.js';
import { openPosition } from '../../../src/controllers/investment/events.js';
import { accounts, assets } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { buildApp, type AppContext } from '../app-builder.js';

let tmpDir: string;
let ctx: AppContext;
let scoped: Scoped;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-open-position-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  scoped = ctx.scopedAs({ userId: OWNER_USER_ID });
  await ctx.db.insert(assets).values([
    {
      id: 'asset-a',
      symbol: 'AAA',
      exchange: 'ZZX',
      name: 'Aaa',
      assetClass: 'stock',
      currency: 'USD',
      pricing: 'market',
    },
    {
      id: 'asset-b',
      symbol: 'BBB',
      exchange: 'ZZX',
      name: 'Bbb',
      assetClass: 'stock',
      currency: 'USD',
      pricing: 'market',
    },
  ]);
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

/** The flow's account read happens, then another writer changes the account's cash, then the flow goes on with what
 *  it read — the race between gathering and writing. Only the first read is stale: the retry reads afresh. */
const racingDeps = (name: string, concurrentCash: number): Deps => {
  let raced = false;
  return {
    ...scoped.deps,
    accounts: {
      ...scoped.deps.accounts,
      findRawById: async (id) => {
        const snapshot = await scoped.deps.accounts.findRawById(id);
        if (!raced) {
          raced = true;
          await scoped.runEffects(() =>
            updateAccount(scoped.deps, { name, initialBalance: concurrentCash }).map(accountAdapters.outcomeToDb),
          );
        }
        return snapshot;
      },
    },
  };
};

const open = (deps: Deps, account: string, asset: string, remainingCash: number) =>
  scoped.runEffects(() =>
    openPosition(deps, { account, asset, quantity: 1, avgCost: 1, remainingCash })
      .map(accountAdapters.outcomeToDb)
      .map(investmentAdapters.outcomeToDb),
  );

const cashOf = async (name: string) => (await scoped.deps.accounts.findByName(name))?.initialBalance;

describe('open_position reads the account once and guards it (ADR-038 §7)', () => {
  it('retries when the cash changes between read and write, and replaces the balance actually there', async () => {
    await createBroker('acc-race-1', 'Broker Race 1', 500);

    const opened = (await open(racingDeps('Broker Race 1', 900), 'Broker Race 1', 'AAA', 85))._unsafeUnwrap();

    expect(opened.replacedCash).toBe(900);
    expect(await cashOf('Broker Race 1')).toBe(85);
  });

  it('guards the version when the cash is unchanged: a concurrent change is retried', async () => {
    await createBroker('acc-race-2', 'Broker Race 2', 85);

    const opened = (await open(racingDeps('Broker Race 2', 300), 'Broker Race 2', 'AAA', 85))._unsafeUnwrap();

    expect(opened.replacedCash).toBe(300);
    expect(await cashOf('Broker Race 2')).toBe(85);
  });

  it('replaces nothing, and restores nothing later, when nobody touched the cash', async () => {
    await createBroker('acc-race-3', 'Broker Race 3', 85);

    const opened = (await open(scoped.deps, 'Broker Race 3', 'AAA', 85))._unsafeUnwrap();

    expect(opened.replacedCash).toBeNull();
    expect(await cashOf('Broker Race 3')).toBe(85);
  });
});

/** Both flows pass the pre-check before either writes — the race of two identical requests. */
const bothReadBeforeEitherWrites = (): (() => Deps) => {
  let arrived = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => ({
    ...scoped.deps,
    investments: {
      ...scoped.deps.investments,
      list: async (filter) => {
        const existing = await scoped.deps.investments.list(filter);
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        return existing;
      },
    },
  });
};

describe('two identical open_position calls at once are safe by design (ADR-029)', () => {
  it('stores one opening and answers both calls with its id, one created and one not', async () => {
    await createBroker('acc-race-4', 'Broker Race 4', 0);
    const deps = bothReadBeforeEitherWrites();
    const [first, second] = await Promise.all([
      open(deps(), 'Broker Race 4', 'BBB', 0),
      open(deps(), 'Broker Race 4', 'BBB', 0),
    ]);
    const answers = [first._unsafeUnwrap(), second._unsafeUnwrap()];

    const stored = await scoped.deps.investments.list({ accountId: 'acc-race-4' });
    expect(stored).toHaveLength(1);
    expect(answers.map((answer) => answer.id)).toEqual([stored[0]!.id, stored[0]!.id]);
    expect(answers.map((answer) => answer.created).sort()).toEqual([false, true]);
  });
});
