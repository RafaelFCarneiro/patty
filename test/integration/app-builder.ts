import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { bootstrap } from '../../src/diplomat/db/bootstrap.js';
import { createTransactionRunner, openDatabase } from '../../src/diplomat/db/driver.js';
import { isSqliteBusy } from '../../src/diplomat/db/sqliteErrors.js';
import { accountApplier, accountsRepo } from '../../src/diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from '../../src/diplomat/db/repos/bills.js';
import { budgetApplier, budgetsRepo } from '../../src/diplomat/db/repos/budgets.js';
import { categoriesRepo, categoryApplier } from '../../src/diplomat/db/repos/categories.js';
import { subCategoriesRepo } from '../../src/diplomat/db/repos/subCategories.js';
import { correlationsRepo } from '../../src/diplomat/db/repos/correlations.js';
import { creditCardApplier, creditCardsRepo } from '../../src/diplomat/db/repos/creditCards.js';
import { currenciesRepo } from '../../src/diplomat/db/repos/currencies.js';
import { currencyRateApplier, currencyRatesRepo } from '../../src/diplomat/db/repos/currencyRates.js';
import { dashboardApplier, dashboardsRepo } from '../../src/diplomat/db/repos/dashboards.js';
import { merchantApplier, merchantCategoryApplier, merchantsRepo } from '../../src/diplomat/db/repos/merchants.js';
import { recurringRepo, recurringRuleApplier } from '../../src/diplomat/db/repos/recurring.js';
import { settingsApplier, settingsRepo } from '../../src/diplomat/db/repos/settings.js';
import { tagApplier, tagsRepo } from '../../src/diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from '../../src/diplomat/db/repos/transactions.js';
import { transactionTagApplier } from '../../src/diplomat/db/repos/transactionTags.js';
import { healthRepo } from '../../src/diplomat/db/repos/health.js';
import { createLocaleResolver } from '../../src/diplomat/db/localeCache.js';
import { accessTokenApplier } from '../../src/diplomat/db/repos/accessTokens.js';
import { clientGrantApplier } from '../../src/diplomat/db/repos/clientGrants.js';
import { sessionApplier } from '../../src/diplomat/db/repos/sessions.js';
import { setupCodeApplier } from '../../src/diplomat/db/repos/setupCodes.js';
import { userApplier } from '../../src/diplomat/db/repos/users.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  CLIENT_GRANT_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  USER_ENTITY_TAG,
} from '../../src/models/auth/entity.js';
import { ACCOUNT_ENTITY_TAG } from '../../src/models/account.js';
import { BILL_ENTITY_TAG } from '../../src/models/bill.js';
import { BUDGET_ENTITY_TAG } from '../../src/models/budget.js';
import { CATEGORY_ENTITY_TAG } from '../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from '../../src/models/creditCard.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../src/models/currencyRate.js';
import { DASHBOARD_ENTITY_TAG } from '../../src/models/dashboard.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from '../../src/models/merchant.js';
import { RECURRING_ENTITY_TAG } from '../../src/models/recurring.js';
import { SETTINGS_ENTITY_TAG } from '../../src/models/locale.js';
import { TAG_ENTITY_TAG } from '../../src/models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../../src/models/transaction.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../../src/models/transactionTag.js';
import { httpOrigin } from '../../src/common/net.js';
import { prepareAuth, type AuthConfig } from '../../src/composition/auth.js';
import type { HttpAuth } from '../../src/diplomat/http/context.js';
import { DISABLED_AUTH } from '../../src/diplomat/http/context.js';
import { buildHttpApp, registerHttpApp } from '../../src/composition/http.js';
import { AuthMode } from '../../src/models/auth/mode.js';
import type { Db } from '../../src/diplomat/db/driver.js';
import type { ApplierRegistry } from '../../src/diplomat/db/effects.js';
import type { Deps, RunEffects, RunEffectsSequence } from '../../src/controllers/deps.js';
import { createChangeBus, runEffects, runEffectsSequence, type ChangeBus } from '@rfc0/effect-runner';
import { conflict } from '../../src/models/error.js';

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

export type AppContext = {
  app: FastifyInstance;
  deps: Deps;
  version: string;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
  changeBus: ChangeBus;
  db: Db;
  /** Wire the same deps/auth onto another Fastify instance (a test that must hook it before routes exist). */
  registerOn: (app: FastifyInstance) => void;
  auth: HttpAuth;
  /** Everything startup printed to stderr — the setup-code banner, in auth-required mode. */
  announced: string[];
};

/** Auth `required` on a loopback bind with the sidecar on — what a container behind a proxy runs. */
export const REQUIRED_AUTH: AuthConfig = {
  FINTRACK_AUTH: AuthMode.enum.required,
  PUBLIC_URL: undefined,
  HOST: '127.0.0.1',
  PORT: 51737,
  MCP_TRANSPORT: 'http',
  FINTRACK_HTTP: true,
  // Only a stdio sign-in's temporary page reads these; the app builder never serves one.
  DB_PATH: '/nonexistent/fintrack.db',
  TRUST_PROXY: undefined,
  FINTRACK_LOCALE: undefined,
  FIAT_RATE_STALE_HOURS: 24,
  CRYPTO_RATE_STALE_HOURS: 1,
};

export const buildApp = async (opts?: {
  port?: number;
  dbPath?: string;
  onChangeError?: (cause: unknown) => void;
  /** Present → sessions are required (ADR-033); omitted → auth disabled, exactly the pre-auth behavior. */
  auth?: Partial<AuthConfig>;
  /** How often an open /ui/events stream re-checks its session (default 30 s; tests shorten it). */
  sessionRecheckMs?: number;
}): Promise<AppContext> => {
  const db = await openDatabase({
    DB_PATH: opts?.dbPath ?? (inject('DB_PATH' as never) as string),
    FINTRACK_DB_KEY: TEST_ENCRYPTION_KEY,
  });

  await bootstrap(db);

  const settingsR = settingsRepo(db);
  const localeResolver = createLocaleResolver(settingsR);

  const deps: Deps = {
    accounts: accountsRepo(db),
    bills: billsRepo(db),
    budgets: budgetsRepo(db),
    categories: categoriesRepo(db),
    subCategories: subCategoriesRepo(db),
    correlations: correlationsRepo(db),
    creditCards: creditCardsRepo(db),
    currencies: currenciesRepo(db),
    currencyRates: currencyRatesRepo(db),
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
    rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  };

  const require = createRequire(import.meta.url);
  const { version } = require('../../package.json') as { version: string };

  const applierRegistry: ApplierRegistry = {
    [ACCOUNT_ENTITY_TAG]: accountApplier,
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [TRANSACTION_TAG_ENTITY_TAG]: transactionTagApplier,
    [MERCHANT_ENTITY_TAG]: merchantApplier,
    [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier,
    [BILL_ENTITY_TAG]: billApplier,
    [BUDGET_ENTITY_TAG]: budgetApplier,
    [TAG_ENTITY_TAG]: tagApplier,
    [CATEGORY_ENTITY_TAG]: categoryApplier,
    [CREDIT_CARD_ENTITY_TAG]: creditCardApplier,
    [CURRENCY_RATE_ENTITY_TAG]: currencyRateApplier,
    [RECURRING_ENTITY_TAG]: recurringRuleApplier,
    [DASHBOARD_ENTITY_TAG]: dashboardApplier,
    [SETTINGS_ENTITY_TAG]: settingsApplier,
    [USER_ENTITY_TAG]: userApplier,
    [SESSION_ENTITY_TAG]: sessionApplier,
    [ACCESS_TOKEN_ENTITY_TAG]: accessTokenApplier,
    [CLIENT_GRANT_ENTITY_TAG]: clientGrantApplier,
    [SETUP_CODE_ENTITY_TAG]: setupCodeApplier,
  };
  const changeBus = createChangeBus({ onError: opts?.onChangeError });
  const engineContext = {
    runner: createTransactionRunner(db),
    isTransientContention: isSqliteBusy,
    conflictError: () => conflict,
    onPublishError: opts?.onChangeError,
  };
  const boundRunEffects: RunEffects = (flow) => runEffects(engineContext, applierRegistry, flow, changeBus.publish);
  const boundRunEffectsSequence: RunEffectsSequence = (items, flowFor) =>
    runEffectsSequence(engineContext, applierRegistry, items, flowFor, changeBus.publish);
  const announced: string[] = [];
  const authConfig: AuthConfig = { ...REQUIRED_AUTH, ...opts?.auth };
  const prepared = opts?.auth
    ? await prepareAuth(authConfig, db, boundRunEffects)
    : { auth: DISABLED_AUTH, issueAndAnnounceSetup: async () => undefined };
  // As a real start does once its server has bound: issue and print the setup code, to the captured stderr.
  await prepared.issueAndAnnounceSetup(httpOrigin(authConfig.HOST, authConfig.PORT), (message) =>
    announced.push(message),
  );
  const auth: HttpAuth =
    prepared.auth.mode === AuthMode.enum.required
      ? { ...prepared.auth, sessionRecheckMs: opts?.sessionRecheckMs }
      : prepared.auth;
  const app = buildHttpApp(
    deps,
    version,
    boundRunEffects,
    boundRunEffectsSequence,
    localeResolver.resetLocale,
    changeBus.subscribe,
    { logger: false, auth },
  );
  const registerOn = (other: FastifyInstance): void =>
    registerHttpApp(
      other,
      deps,
      version,
      boundRunEffects,
      boundRunEffectsSequence,
      localeResolver.resetLocale,
      changeBus.subscribe,
      auth,
    );

  return {
    app,
    db,
    registerOn,
    auth,
    announced,
    deps,
    version,
    runEffects: boundRunEffects,
    runEffectsSequence: boundRunEffectsSequence,
    changeBus,
  };
};
