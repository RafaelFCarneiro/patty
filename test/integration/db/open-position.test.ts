import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as accountAdapters from '../../../src/adapters/accounts.js';
import * as investmentAdapters from '../../../src/adapters/investment-events.js';
import { updateAccount } from '../../../src/controllers/account/account.js';
import type { Deps, Scoped } from '../../../src/controllers/deps.js';
import { deleteInvestmentEvent, openPosition } from '../../../src/controllers/investment/events.js';
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

const cashBeforeOf = async (id: string) => (await scoped.deps.accounts.findRawById(id))?.cashBeforeHoldings;

describe('open_position reads the account once and guards it (ADR-038 §7)', () => {
  it('retries when the cash changes between read and write, and replaces the balance actually there', async () => {
    await createBroker('acc-race-1', 'Broker Race 1', 500);

    (await open(racingDeps('Broker Race 1', 900), 'Broker Race 1', 'AAA', 85))._unsafeUnwrap();

    expect(await cashBeforeOf('acc-race-1')).toBe(900);
    expect(await cashOf('Broker Race 1')).toBe(85);
  });

  it('writes the account even when the cash stays, so a concurrent change is retried', async () => {
    await createBroker('acc-race-2', 'Broker Race 2', 85);

    (await open(racingDeps('Broker Race 2', 300), 'Broker Race 2', 'AAA', 85))._unsafeUnwrap();

    expect(await cashBeforeOf('acc-race-2')).toBe(300);
    expect(await cashOf('Broker Race 2')).toBe(85);
  });

  it('remembers nothing when the cash stays what it was', async () => {
    await createBroker('acc-race-3', 'Broker Race 3', 85);

    (await open(scoped.deps, 'Broker Race 3', 'AAA', 85))._unsafeUnwrap();

    expect(await cashBeforeOf('acc-race-3')).toBeNull();
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

/** The flow reads the account, then `between` runs to completion, then the flow goes on with what it read. */
const interleaved = (between: () => Promise<unknown>): Deps => {
  let done = false;
  return {
    ...scoped.deps,
    accounts: {
      ...scoped.deps.accounts,
      findRawById: async (id) => {
        const snapshot = await scoped.deps.accounts.findRawById(id);
        if (!done) {
          done = true;
          await between();
        }
        return snapshot;
      },
    },
  };
};

const remove = (deps: Deps, id: string) =>
  scoped.runEffects(() =>
    deleteInvestmentEvent(deps, { id }).map(accountAdapters.outcomeToDb).map(investmentAdapters.outcomeToDb),
  );

const eventCount = async (accountId: string) => (await scoped.deps.investments.list({ accountId })).length;

describe('a sibling opening and a deletion on one account conflict on its version (ADR-038 §7)', () => {
  it('a deletion that lands while a sibling opens makes the sibling retry: nothing is double counted', async () => {
    await createBroker('acc-race-5', 'Broker Race 5', 700);
    const first = (await open(scoped.deps, 'Broker Race 5', 'AAA', 85))._unsafeUnwrap();
    expect(await cashBeforeOf('acc-race-5')).toBe(700);

    const opening = interleaved(async () => (await remove(scoped.deps, first.id))._unsafeUnwrap());
    (await open(opening, 'Broker Race 5', 'BBB', 85))._unsafeUnwrap();

    expect(await eventCount('acc-race-5')).toBe(1);
    expect(await cashOf('Broker Race 5')).toBe(85);
    expect(await cashBeforeOf('acc-race-5')).toBe(700);
  });

  it('a sibling that opens while a deletion decides makes the deletion retry, and it restores nothing', async () => {
    await createBroker('acc-race-6', 'Broker Race 6', 700);
    const first = (await open(scoped.deps, 'Broker Race 6', 'AAA', 85))._unsafeUnwrap();

    const deleting = interleaved(async () => (await open(scoped.deps, 'Broker Race 6', 'BBB', 85))._unsafeUnwrap());
    const deleted = (await remove(deleting, first.id))._unsafeUnwrap();

    expect(deleted.restoredCash).toBeUndefined();
    expect(await eventCount('acc-race-6')).toBe(1);
    expect(await cashOf('Broker Race 6')).toBe(85);
    expect(await cashBeforeOf('acc-race-6')).toBe(700);
  });

  it('with no sibling in between, the last deletion restores the 700 and forgets it', async () => {
    await createBroker('acc-race-7', 'Broker Race 7', 700);
    const only = (await open(scoped.deps, 'Broker Race 7', 'AAA', 85))._unsafeUnwrap();

    const deleted = (await remove(scoped.deps, only.id))._unsafeUnwrap();

    expect(deleted.restoredCash).toEqual({ account: 'Broker Race 7', initialBalance: 700 });
    expect(await cashOf('Broker Race 7')).toBe(700);
    expect(await cashBeforeOf('acc-race-7')).toBeNull();
  });
});
