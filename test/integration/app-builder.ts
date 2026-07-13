import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { bootstrap } from '../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../src/diplomat/db/driver.js';
import { accountsRepo } from '../../src/diplomat/db/repos/accounts.js';
import { billsRepo } from '../../src/diplomat/db/repos/bills.js';
import { categoriesRepo } from '../../src/diplomat/db/repos/categories.js';
import { subCategoriesRepo } from '../../src/diplomat/db/repos/subCategories.js';
import { creditCardsRepo } from '../../src/diplomat/db/repos/creditCards.js';
import { dashboardsRepo } from '../../src/diplomat/db/repos/dashboards.js';
import { merchantsRepo } from '../../src/diplomat/db/repos/merchants.js';
import { recurringRepo } from '../../src/diplomat/db/repos/recurring.js';
import { settingsRepo } from '../../src/diplomat/db/repos/settings.js';
import { tagsRepo } from '../../src/diplomat/db/repos/tags.js';
import { transactionsRepo } from '../../src/diplomat/db/repos/transactions.js';
import { healthRepo } from '../../src/diplomat/db/repos/health.js';
import { McpTransport } from '../../src/config.js';
import { Locale } from '../../src/models/locale.js';
import { buildHttpApp } from '../../src/server.js';
import { withUnitOfWork } from '../../src/diplomat/db/unitOfWork.js';
import type { Deps, UnitOfWork } from '../../src/controllers/deps.js';

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

export type AppContext = { app: FastifyInstance; deps: Deps; version: string; unitOfWork: UnitOfWork };

export const buildApp = async (opts?: { port?: number; dbPath?: string }): Promise<AppContext> => {
  const db = openDatabase({
    DB_PATH: opts?.dbPath ?? (inject('DB_PATH') as string),
    FINTRACK_DB_KEY: TEST_ENCRYPTION_KEY,
    PORT: opts?.port ?? 0,
    MCP_TRANSPORT: McpTransport.enum.http,
  });

  await bootstrap(db);

  const settingsR = settingsRepo(db);

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
    locale: async () => {
      const row = await settingsR.getLocale();
      return row?.locale ?? Locale.enum.en;
    },
    resetLocale: () => {},
  };

  const require = createRequire(import.meta.url);
  const { version } = require('../../package.json') as { version: string };

  const unitOfWork: UnitOfWork = (flow) => withUnitOfWork(db, flow);
  const app = buildHttpApp(deps, version, unitOfWork, { logger: false });

  return { app, deps, version, unitOfWork };
};
