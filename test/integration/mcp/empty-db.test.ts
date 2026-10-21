import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { createTransactionRunner, openDatabase } from '../../../src/diplomat/db/driver.js';
import { accountsRepo } from '../../../src/diplomat/db/repos/accounts.js';
import { billsRepo } from '../../../src/diplomat/db/repos/bills.js';
import { budgetsRepo } from '../../../src/diplomat/db/repos/budgets.js';
import { categoriesRepo } from '../../../src/diplomat/db/repos/categories.js';
import { subCategoriesRepo } from '../../../src/diplomat/db/repos/sub-categories.js';
import { correlationsRepo } from '../../../src/diplomat/db/repos/correlations.js';
import { creditCardsRepo } from '../../../src/diplomat/db/repos/credit-cards.js';
import { currenciesRepo } from '../../../src/diplomat/db/repos/currencies.js';
import { currencyRatesRepo } from '../../../src/diplomat/db/repos/currency-rates.js';
import { dashboardsRepo } from '../../../src/diplomat/db/repos/dashboards.js';
import { healthRepo } from '../../../src/diplomat/db/repos/health.js';
import { merchantsRepo } from '../../../src/diplomat/db/repos/merchants.js';
import { recurringRepo } from '../../../src/diplomat/db/repos/recurring.js';
import { settingsRepo, userSettingsApplier } from '../../../src/diplomat/db/repos/settings.js';
import { tagsRepo } from '../../../src/diplomat/db/repos/tags.js';
import { transactionsRepo } from '../../../src/diplomat/db/repos/transactions.js';
import type { ApplierRegistry } from '../../../src/diplomat/db/effects.js';
import { isSqliteBusy } from '../../../src/diplomat/db/sqlite-errors.js';
import { runEffects } from '@rfc0/effect-runner';
import { Locale, LocaleSource, USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { conflict } from '../../../src/models/error.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { listCategories } from '../../../src/controllers/categories.js';
import { getPreferences, setLocale } from '../../../src/controllers/settings.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';

const TEST_KEY = 'b'.repeat(64);
const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

let tmpDir: string;
let deps: Deps;
let registry: ApplierRegistry;
let db: Awaited<ReturnType<typeof openDatabase>>;
let runner: ReturnType<typeof createTransactionRunner>;

describe('empty DB (ADR-008)', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-empty-'));
    db = await openDatabase({
      DB_PATH: join(tmpDir, 'empty.db'),
      FINTRACK_DB_KEY: TEST_KEY,
    });
    runner = createTransactionRunner(db);
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const settingsR = settingsRepo(db, OWNER_USER_ID);
    deps = {
      accounts: accountsRepo(db, OWNER_USER_ID),
      bills: billsRepo(db, OWNER_USER_ID),
      budgets: budgetsRepo(db, OWNER_USER_ID),
      categories: categoriesRepo(db, OWNER_USER_ID),
      subCategories: subCategoriesRepo(db, OWNER_USER_ID),
      correlations: correlationsRepo(db, OWNER_USER_ID),
      creditCards: creditCardsRepo(db, OWNER_USER_ID),
      currencies: currenciesRepo(db),
      currencyRates: currencyRatesRepo(db),
      dashboards: dashboardsRepo(db, OWNER_USER_ID),
      health: healthRepo(db),
      merchants: merchantsRepo(db, OWNER_USER_ID),
      recurring: recurringRepo(db, OWNER_USER_ID),
      settings: settingsR,
      tags: tagsRepo(db, OWNER_USER_ID),
      transactions: transactionsRepo(db, OWNER_USER_ID),
      clock: () => new Date(),
      newId: () => randomUUID(),
      locale: async () => {
        const row = await settingsR.getLocale();
        return row?.locale ?? Locale.enum.en;
      },
      rateStaleness: { fiatHours: 24, cryptoHours: 1 },
    };
    registry = { [USER_SETTINGS_ENTITY_TAG]: userSettingsApplier(OWNER_USER_ID) };
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list_categories returns empty array on unseeded DB', async () => {
    const categories = await listCategories(deps);
    expect(categories).toEqual([]);
  });

  it('get_preferences returns default locale on fresh DB, base currency derived from it', async () => {
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({
      locale: Locale.enum.en,
      localeSource: LocaleSource.enum.default,
      baseCurrency: CurrencyCode.enum.USD,
    });
  });

  it('inferred set_locale switches locale and stores inferred source', async () => {
    const flow = () => setLocale(deps, { locale: Locale.enum.pt, source: LocaleSource.enum.inferred });
    const result = await runEffects(
      { runner, isTransientContention: isSqliteBusy, conflictError: () => conflict },
      registry,
      flow,
    );
    expect(result._unsafeUnwrap()).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.inferred });
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({
      locale: Locale.enum.pt,
      localeSource: LocaleSource.enum.inferred,
      baseCurrency: CurrencyCode.enum.BRL,
    });
  });
});
