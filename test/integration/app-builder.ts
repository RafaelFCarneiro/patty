import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { bootstrap } from '../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../src/diplomat/db/driver.js';
import { accountApplier, accountsRepo } from '../../src/diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from '../../src/diplomat/db/repos/bills.js';
import { categoriesRepo, categoryApplier } from '../../src/diplomat/db/repos/categories.js';
import { subCategoriesRepo } from '../../src/diplomat/db/repos/subCategories.js';
import { creditCardApplier, creditCardsRepo } from '../../src/diplomat/db/repos/creditCards.js';
import { dashboardApplier, dashboardsRepo } from '../../src/diplomat/db/repos/dashboards.js';
import { merchantCategoryApplier, merchantsRepo } from '../../src/diplomat/db/repos/merchants.js';
import { recurringRepo, recurringRuleApplier } from '../../src/diplomat/db/repos/recurring.js';
import { settingsApplier, settingsRepo } from '../../src/diplomat/db/repos/settings.js';
import { tagApplier, tagsRepo } from '../../src/diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from '../../src/diplomat/db/repos/transactions.js';
import { healthRepo } from '../../src/diplomat/db/repos/health.js';
import { createLocaleResolver } from '../../src/diplomat/db/localeCache.js';
import { McpTransport } from '../../src/config.js';
import { ACCOUNT_ENTITY_TAG } from '../../src/models/account.js';
import { BILL_ENTITY_TAG } from '../../src/models/bill.js';
import { CATEGORY_ENTITY_TAG } from '../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from '../../src/models/creditCard.js';
import { DASHBOARD_ENTITY_TAG } from '../../src/models/dashboard.js';
import { MERCHANT_CATEGORY_ENTITY_TAG } from '../../src/models/merchant.js';
import { RECURRING_ENTITY_TAG } from '../../src/models/recurring.js';
import { SETTINGS_ENTITY_TAG } from '../../src/models/locale.js';
import { TAG_ENTITY_TAG } from '../../src/models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../../src/models/transaction.js';
import { buildHttpApp } from '../../src/server.js';
import { runEffects, runEffectsSequence, type ApplierRegistry } from '../../src/diplomat/db/effects.js';
import type { Deps, RunEffects, RunEffectsSequence } from '../../src/controllers/deps.js';

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

export type AppContext = {
  app: FastifyInstance;
  deps: Deps;
  version: string;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
};

export const buildApp = async (opts?: { port?: number; dbPath?: string }): Promise<AppContext> => {
  const db = openDatabase({
    DB_PATH: opts?.dbPath ?? (inject('DB_PATH') as string),
    FINTRACK_DB_KEY: TEST_ENCRYPTION_KEY,
    PORT: opts?.port ?? 0,
    MCP_TRANSPORT: McpTransport.enum.http,
  });

  await bootstrap(db);

  const settingsR = settingsRepo(db);
  const localeResolver = createLocaleResolver(settingsR);

  const deps: Deps = {
    accounts: accountsRepo(db),
    bills: billsRepo(db),
    categories: categoriesRepo(db),
    subCategories: subCategoriesRepo(db),
    creditCards: creditCardsRepo(db),
    dashboards: dashboardsRepo(db),
    health: healthRepo(db),
    merchants: merchantsRepo(db),
    recurring: recurringRepo(db),
    settings: settingsR,
    tags: tagsRepo(db),
    transactions: transactionsRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    locale: localeResolver.locale,
  };

  const require = createRequire(import.meta.url);
  const { version } = require('../../package.json') as { version: string };

  const applierRegistry: ApplierRegistry = {
    [ACCOUNT_ENTITY_TAG]: accountApplier,
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier,
    [BILL_ENTITY_TAG]: billApplier,
    [TAG_ENTITY_TAG]: tagApplier,
    [CATEGORY_ENTITY_TAG]: categoryApplier,
    [CREDIT_CARD_ENTITY_TAG]: creditCardApplier,
    [RECURRING_ENTITY_TAG]: recurringRuleApplier,
    [DASHBOARD_ENTITY_TAG]: dashboardApplier,
    [SETTINGS_ENTITY_TAG]: settingsApplier,
  };
  const boundRunEffects: RunEffects = (flow) => runEffects(db, applierRegistry, flow);
  const boundRunEffectsSequence: RunEffectsSequence = (items, flowFor) =>
    runEffectsSequence(db, applierRegistry, items, flowFor);
  const app = buildHttpApp(deps, version, boundRunEffects, boundRunEffectsSequence, localeResolver.resetLocale, {
    logger: false,
  });

  return { app, deps, version, runEffects: boundRunEffects, runEffectsSequence: boundRunEffectsSequence };
};
