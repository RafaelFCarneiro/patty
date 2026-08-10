import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { accountsRepo } from '../../../src/diplomat/db/repos/accounts.js';
import { billsRepo } from '../../../src/diplomat/db/repos/bills.js';
import { budgetsRepo } from '../../../src/diplomat/db/repos/budgets.js';
import { categoriesRepo } from '../../../src/diplomat/db/repos/categories.js';
import { subCategoriesRepo } from '../../../src/diplomat/db/repos/subCategories.js';
import { correlationsRepo } from '../../../src/diplomat/db/repos/correlations.js';
import { creditCardsRepo } from '../../../src/diplomat/db/repos/creditCards.js';
import { currenciesRepo } from '../../../src/diplomat/db/repos/currencies.js';
import { dashboardsRepo } from '../../../src/diplomat/db/repos/dashboards.js';
import { healthRepo } from '../../../src/diplomat/db/repos/health.js';
import { merchantsRepo } from '../../../src/diplomat/db/repos/merchants.js';
import { recurringRepo } from '../../../src/diplomat/db/repos/recurring.js';
import { settingsApplier, settingsRepo } from '../../../src/diplomat/db/repos/settings.js';
import { tagsRepo } from '../../../src/diplomat/db/repos/tags.js';
import { transactionsRepo } from '../../../src/diplomat/db/repos/transactions.js';
import { runEffects, type ApplierRegistry } from '../../../src/diplomat/db/effects.js';
import { McpTransport } from '../../../src/config.js';
import { Locale, LocaleSource, SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { listCategories } from '../../../src/controllers/categories.js';
import { getPreferences, setLocale } from '../../../src/controllers/settings.js';
import type { Deps } from '../../../src/controllers/deps.js';

const TEST_KEY = 'b'.repeat(64);
const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

let tmpDir: string;
let deps: Deps;
let registry: ApplierRegistry;
let db: Awaited<ReturnType<typeof openDatabase>>;

describe('empty DB (ADR-008)', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-empty-'));
    db = await openDatabase({
      DB_PATH: join(tmpDir, 'empty.db'),
      FINTRACK_DB_KEY: TEST_KEY,
      PORT: 0,
      MCP_TRANSPORT: McpTransport.enum.stdio,
      FINTRACK_HTTP: true,
    });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const settingsR = settingsRepo(db);
    deps = {
      accounts: accountsRepo(db),
      bills: billsRepo(db),
      budgets: budgetsRepo(db),
      categories: categoriesRepo(db),
      subCategories: subCategoriesRepo(db),
      correlations: correlationsRepo(db),
      creditCards: creditCardsRepo(db),
      currencies: currenciesRepo(db),
      dashboards: dashboardsRepo(db),
      health: healthRepo(db),
      merchants: merchantsRepo(db),
      recurring: recurringRepo(db),
      settings: settingsR,
      tags: tagsRepo(db),
      transactions: transactionsRepo(db),
      clock: () => new Date(),
      newId: () => randomUUID(),
      locale: async () => {
        const row = await settingsR.getLocale();
        return row?.locale ?? Locale.enum.en;
      },
    };
    registry = { [SETTINGS_ENTITY_TAG]: settingsApplier };
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list_categories returns empty array on unseeded DB', async () => {
    const categories = await listCategories(deps);
    expect(categories).toEqual([]);
  });

  it('get_preferences returns default locale on fresh DB', async () => {
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({ locale: Locale.enum.en, localeSource: LocaleSource.enum.default });
  });

  it('inferred set_locale switches locale and stores inferred source', async () => {
    const flow = () => setLocale(deps, { locale: Locale.enum.pt, source: LocaleSource.enum.inferred });
    const result = await runEffects(db, registry, flow);
    expect(result._unsafeUnwrap()).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.inferred });
    const prefs = await getPreferences(deps);
    expect(prefs).toEqual({ locale: Locale.enum.pt, localeSource: LocaleSource.enum.inferred });
  });
});
