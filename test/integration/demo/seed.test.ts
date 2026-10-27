import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import * as R from 'remeda';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../../src/composition/demo-seed.js';
import { createRuntime } from '../../../src/composition/runtime.js';
import { getAccountBalances } from '../../../src/controllers/account/account.js';
import { getBudgetStatus } from '../../../src/controllers/budgets.js';
import { listCreditCards } from '../../../src/controllers/credit-card/credit-card.js';
import { scopedFor } from '../../../src/controllers/deps.js';
import { getPreferences } from '../../../src/controllers/settings.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DEMO_PACKS } from '../../../src/diplomat/db/seed/demo/index.js';
import { planDemo } from '../../../src/logic/demo.js';
import { OWNER_PRINCIPAL } from '../../../src/models/auth/principal.js';
import { BillStatus } from '../../../src/models/bill.js';
import { DemoCountry, DemoSeedStatus } from '../../../src/models/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { TransactionStatus } from '../../../src/models/transaction.js';

const TEST_KEY = 'd'.repeat(64);
const TODAY = new Date(2026, 9, 26, 9);
const LAST_FULL_MONTH = { month: 9, year: 2026 };
const CONFIG = { FIAT_RATE_STALE_HOURS: 24, CRYPTO_RATE_STALE_HOURS: 1 };
const COUNTRIES = Object.values(DemoCountry.enum);

let dir: string;
let db: Db;

const seed = (country: DemoCountry) => seedDemo(db, { country, today: TODAY, config: CONFIG });

const owner = () =>
  scopedFor(createRuntime(db, { ...CONFIG, FINTRACK_LOCALE: undefined }, { clock: () => TODAY }), OWNER_PRINCIPAL);

const count = async (table: string, where = '1 = 1'): Promise<number> => {
  const [row] = await db.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`));
  return row?.n ?? 0;
};

const existingData = async () => ({
  rates: await count('currency_rates'),
  history: await count('merchant_category', 'user_id IS NOT NULL'),
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-demo-seed-'));
  db = await openDatabase({ DB_PATH: join(dir, 'demo.db'), FINTRACK_DB_KEY: TEST_KEY });
  await bootstrap(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('seedDemo — marking and idempotency', () => {
  it('marks a fresh database as a demo, in the pack’s language', async () => {
    const report = (await seed(DemoCountry.enum.mx))._unsafeUnwrap();
    expect(report.status).toBe(DemoSeedStatus.enum.seeded);
    const { deps } = owner();
    expect(await deps.instance.kind()).toBe(InstanceKind.enum.demo);
    expect(await deps.instance.locale()).toBe('es');
    expect(await getPreferences(deps)).toMatchObject({ locale: 'es', baseCurrency: CurrencyCode.enum.MXN });
  });

  it('does not duplicate anything when run again on a seeded demo', async () => {
    await seed(DemoCountry.enum.us);
    const totals = async () => ({ transactions: await count('transactions'), accounts: await count('accounts') });
    const before = await totals();
    const again = (await seed(DemoCountry.enum.us))._unsafeUnwrap();
    expect(again).toEqual({ status: DemoSeedStatus.enum.present, steps: {} });
    expect(await totals()).toEqual(before);
  });

  it('refuses a database that holds data and is not a demo', async () => {
    await seed(DemoCountry.enum.br);
    await db.run(sql`UPDATE settings SET instance_kind = 'standard' WHERE id = 'singleton'`);
    const refused = await seed(DemoCountry.enum.br);
    expect(refused._unsafeUnwrap()).toEqual({ status: DemoSeedStatus.enum.not_demo, steps: {} });
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
  });

  it('names the step that failed, as a validation error', async () => {
    await db.run(sql`DELETE FROM categories`);
    const failed = await seed(DemoCountry.enum.us);
    expect(failed._unsafeUnwrapErr()).toMatchObject({
      code: 'validation',
      issues: [expect.stringContaining('demo seed failed at')],
    });
  });

  it('speaks English when the stored language is missing or not one we know', async () => {
    expect(await owner().deps.instance.locale()).toBe('en');
    await db.run(
      sql`INSERT INTO user_settings (user_id, locale, locale_source) VALUES ('user-owner', 'xx', 'explicit')`,
    );
    expect(await owner().deps.instance.locale()).toBe('en');
  });

  it.each([
    [
      'an accountless transaction',
      'INSERT INTO transactions (id, user_id, description, amount, type, status, date, currency, source, ' +
        'idempotency_key, classification_method, confidence, version) ' +
        "VALUES ('t1','user-owner','x',1,'expense','effective','2026-10-01','USD','mcp','k1','none',0,0)",
    ],
    ['a tag', "INSERT INTO tags (id, user_id, name, version) VALUES ('g1','user-owner','solo',0)"],
  ])('refuses an unmarked database holding %s', async (_label, insert) => {
    await db.run(sql.raw(insert));
    expect((await seed(DemoCountry.enum.us))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.not_demo);
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
  });

  it.each([
    [
      'a user-created category',
      "INSERT INTO categories (id, name, kind, user_id, version) VALUES ('c9','Pets','expense','user-owner',0)",
    ],
    [
      'an inline dashboard',
      'INSERT INTO dashboards (id, name, html, source, updated_at, user_id, version) ' +
        "VALUES ('d9','Mine','<p>x</p>','inline','2026-01-01T00:00:00.000Z','user-owner',0)",
    ],
  ])('refuses an unmarked database holding %s', async (_label, insert) => {
    await db.run(sql.raw(insert));
    expect((await seed(DemoCountry.enum.us))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.not_demo);
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
  });

  it.each([
    [
      'a saved exchange rate',
      'INSERT INTO currency_rates (id, from_code, to_code, rate, as_of, version) ' +
        "VALUES ('r1','USDC','USD',1,'2026-01-01T00:00:00.000Z',0)",
    ],
    [
      'retained merchant history',
      'INSERT INTO merchant_category (merchant_key, category_id, weight, origin, user_id) ' +
        "VALUES ('amazon','cat-shopping',1,'history','user-owner')",
    ],
  ])('refuses an unmarked database holding %s, leaving it as it was', async (_label, insert) => {
    await db.run(sql`INSERT OR IGNORE INTO merchants (key) VALUES ('amazon')`);
    await db.run(sql.raw(insert));
    const before = {
      rates: await count('currency_rates'),
      history: await count('merchant_category', 'user_id IS NOT NULL'),
    };
    expect((await seed(DemoCountry.enum.us))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.not_demo);
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
    expect(await existingData()).toEqual(before);
    expect(await count('accounts')).toBe(0);
  });

  it('seeds a database holding only the shared defaults', async () => {
    expect(await count('categories', 'user_id IS NULL')).toBeGreaterThan(0);
    expect((await seed(DemoCountry.enum.us))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.seeded);
  });

  it('refuses an unmarked database holding another user’s accounts', async () => {
    await db.run(
      sql`INSERT INTO users (id, username, role, created_at) VALUES ('user-2', 'other', 'member', '2026-01-01T00:00:00.000Z')`,
    );
    await db.run(
      sql`INSERT INTO accounts (id, user_id, name, type, currency, initial_balance, version) VALUES ('a2','user-2','Theirs','checking','USD',0,0)`,
    );
    expect((await seed(DemoCountry.enum.us))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.not_demo);
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
  });

  it('stamps exchange rates with the seed instant, so they start fresh', async () => {
    await seed(DemoCountry.enum.br);
    const rows = await db.all<{ as_of: string }>(sql`SELECT as_of FROM currency_rates`);
    expect(rows.map((row) => row.as_of)).toEqual(rows.map(() => TODAY.toISOString()));
  });

  it('seeds an empty database that is not yet marked, and marks it', async () => {
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
    expect((await seed(DemoCountry.enum.co))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.seeded);
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.demo);
  });
});

const seededAt = async (): Promise<string | null> => {
  const [row] = await db.all<{ at: string | null }>(sql`SELECT demo_seeded_at AS at FROM settings`);
  return row?.at ?? null;
};

describe('seedDemo — the completion marker', () => {
  it('is written as the last step, with the instant the seed ran', async () => {
    expect(await seededAt()).toBeNull();
    expect((await seed(DemoCountry.enum.us))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.seeded);
    expect(await seededAt()).toBe(TODAY.toISOString());
  });

  it('is not written when a step fails, which leaves a demo that says it is one but was never finished', async () => {
    await db.run(sql`DELETE FROM categories`);
    expect((await seed(DemoCountry.enum.us)).isErr()).toBe(true);
    expect(await seededAt()).toBeNull();
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.demo);
  });

  it('reports an interrupted seed instead of calling it already seeded, and writes nothing more', async () => {
    await db.run(sql`DELETE FROM categories`);
    await seed(DemoCountry.enum.us);
    const before = { transactions: await count('transactions'), accounts: await count('accounts') };
    expect(before.accounts).toBeGreaterThan(0);

    const again = (await seed(DemoCountry.enum.us))._unsafeUnwrap();

    expect(again).toEqual({ status: DemoSeedStatus.enum.interrupted, steps: {} });
    expect({ transactions: await count('transactions'), accounts: await count('accounts') }).toEqual(before);
    expect(await seededAt()).toBeNull();
  });

  it('keeps the first instant when a seeded demo is run again', async () => {
    await seed(DemoCountry.enum.br);
    const later = { country: DemoCountry.enum.br, today: new Date(2026, 10, 2, 9), config: CONFIG };
    expect((await seedDemo(db, later))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.present);
    expect(await seededAt()).toBe(TODAY.toISOString());
  });

  it('starts over on a demo that was marked but never got any data (a stop right after the marker)', async () => {
    await db.run(sql`UPDATE settings SET instance_kind = 'demo' WHERE id = 'singleton'`);
    expect((await seed(DemoCountry.enum.mx))._unsafeUnwrap().status).toBe(DemoSeedStatus.enum.seeded);
    expect(await seededAt()).toBe(TODAY.toISOString());
  });
});

describe.each(COUNTRIES)('seeded demo — %s', (country) => {
  const pack = DEMO_PACKS[country];

  beforeEach(async () => {
    (await seed(country))._unsafeUnwrap();
  });

  it('has the expected accounts, cards, tags, rules, budgets and rates', async () => {
    const accounts = pack.global ? 7 : 6;
    expect(await count('accounts', "type != 'credit'")).toBe(accounts);
    expect(await count('accounts', "type = 'credit'")).toBe(2);
    expect(await count('credit_cards')).toBe(2);
    expect(await count('tags')).toBe(pack.tags.length);
    expect(await count('recurring_rules')).toBe(2 + pack.subscriptions.length);
    expect(await count('budgets')).toBeGreaterThanOrEqual(4);
    expect(await count('currency_rates')).toBe(pack.global ? 3 : 2);
  });

  it('generates every transaction through the flows: the plan’s writes all landed', async () => {
    const plan = planDemo(pack, '2026-10-26', TODAY.toISOString());
    const spent = plan.filter((step) => ['expense', 'income', 'purchase', 'transfer'].includes(step.kind)).length;
    const billPayments = plan.filter((step) => step.kind === 'payBill').length - 1;
    expect(await count('transactions', "type != 'transfer' OR bill_id IS NULL")).toBeGreaterThan(spent - 1);
    expect(await count('transactions')).toBeGreaterThanOrEqual(spent + billPayments);
  });

  it('has bills that are paid, closed and open', async () => {
    const { deps } = owner();
    const bills = R.flat(
      await Promise.all((await listCreditCards(deps)).map((card) => deps.bills.findAllByCard(card.id))),
    );
    const statuses = R.unique(bills.map((bill) => bill.status));
    expect(statuses).toEqual(expect.arrayContaining(Object.values(BillStatus.enum)));
  });

  it('has budgets both over and under last month’s spend', async () => {
    const status = await getBudgetStatus(owner().deps, LAST_FULL_MONTH);
    const remaining = status.categories.flatMap((group) => group.lines.map((line) => line.remaining));
    expect(remaining.some((left) => left < 0)).toBe(true);
    expect(remaining.some((left) => left > 0)).toBe(true);
  });

  it('has pending future items and cleared history', async () => {
    expect(await count('transactions', `status = '${TransactionStatus.enum.pending}' AND date > '2026-10-26'`)).toBe(
      pack.pending.length,
    );
    expect(await count('transactions', `status = '${TransactionStatus.enum.effective}'`)).toBeGreaterThan(100);
    expect(await count('transactions', `status = '${TransactionStatus.enum.effective}' AND date > '2026-10-26'`)).toBe(
      0,
    );
  });

  it('has the untagged trip, findable by its destination', async () => {
    const trip = await count('transactions', `description LIKE '%${pack.trip.destination}%'`);
    expect(trip).toBe(pack.trip.items.length);
    expect(await count('transaction_tags')).toBeGreaterThan(0);
    expect(
      await count(
        'transaction_tags',
        `transaction_id IN (SELECT id FROM transactions WHERE description LIKE '%${pack.trip.destination}%')`,
      ),
    ).toBe(0);
  });

  it('values the crypto position in the pack’s currency', async () => {
    const { balances, consolidatedNetWorth } = (await getAccountBalances(owner().deps))._unsafeUnwrap();
    expect(consolidatedNetWorth.baseCurrency).toBe(pack.currency);
    expect(consolidatedNetWorth.excluded).toEqual([]);
    expect(balances.every((balance) => balance.converted)).toBe(true);
  });
});
