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
import { DemoCountry } from '../../../src/models/demo.js';
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
    expect(report.seeded).toBe(true);
    const { deps } = owner();
    expect(await deps.instance.kind()).toBe(InstanceKind.enum.demo);
    expect(await deps.instance.locale()).toBe('es');
    expect(await getPreferences(deps)).toMatchObject({ locale: 'es', baseCurrency: CurrencyCode.enum.MXN });
  });

  it('does not duplicate anything when run again on a seeded demo', async () => {
    await seed(DemoCountry.enum.us);
    const before = { transactions: await count('transactions'), accounts: await count('accounts') };
    const again = (await seed(DemoCountry.enum.us))._unsafeUnwrap();
    expect(again).toEqual({ seeded: false, steps: {} });
    expect({ transactions: await count('transactions'), accounts: await count('accounts') }).toEqual(before);
  });

  it('refuses a database that holds data and is not a demo', async () => {
    await seed(DemoCountry.enum.br);
    await db.run(sql`UPDATE settings SET instance_kind = 'standard' WHERE id = 'singleton'`);
    const refused = await seed(DemoCountry.enum.br);
    expect(refused._unsafeUnwrapErr()).toMatchObject({ code: 'validation' });
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
  });

  it('seeds an empty database that is not yet marked, and marks it', async () => {
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.standard);
    expect((await seed(DemoCountry.enum.co))._unsafeUnwrap().seeded).toBe(true);
    expect(await owner().deps.instance.kind()).toBe(InstanceKind.enum.demo);
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
    const plan = planDemo(pack, '2026-10-26');
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
