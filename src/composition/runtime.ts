import { randomUUID } from 'node:crypto';
import { createChangeBus, runEffects, runEffectsSequence, type ChangeBus } from '@rfc0/effect-runner';
import { AUTH_APPLIERS } from './auth.js';
import type { Config } from '../config.js';
import type { Deps, RunEffects, RunEffectsSequence } from '../controllers/deps.js';
import type { Db } from '../diplomat/db/driver.js';
import { createEngineContext } from '../diplomat/db/engine.js';
import type { ApplierRegistry } from '../diplomat/db/effects.js';
import { createLocaleResolver } from '../diplomat/db/localeCache.js';
import { accountApplier, accountsRepo } from '../diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from '../diplomat/db/repos/bills.js';
import { budgetApplier, budgetsRepo } from '../diplomat/db/repos/budgets.js';
import { categoriesRepo, categoryApplier } from '../diplomat/db/repos/categories.js';
import { correlationsRepo } from '../diplomat/db/repos/correlations.js';
import { creditCardApplier, creditCardsRepo } from '../diplomat/db/repos/creditCards.js';
import { currenciesRepo } from '../diplomat/db/repos/currencies.js';
import { currencyRateApplier, currencyRatesRepo } from '../diplomat/db/repos/currencyRates.js';
import { dashboardApplier, dashboardsRepo } from '../diplomat/db/repos/dashboards.js';
import { healthRepo } from '../diplomat/db/repos/health.js';
import { merchantApplier, merchantCategoryApplier, merchantsRepo } from '../diplomat/db/repos/merchants.js';
import { recurringRepo, recurringRuleApplier } from '../diplomat/db/repos/recurring.js';
import { settingsApplier, settingsRepo } from '../diplomat/db/repos/settings.js';
import { subCategoriesRepo } from '../diplomat/db/repos/subCategories.js';
import { tagApplier, tagsRepo } from '../diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from '../diplomat/db/repos/transactions.js';
import { transactionTagApplier } from '../diplomat/db/repos/transactionTags.js';
import { ACCOUNT_ENTITY_TAG } from '../models/account.js';
import { BILL_ENTITY_TAG } from '../models/bill.js';
import { BUDGET_ENTITY_TAG } from '../models/budget.js';
import { CATEGORY_ENTITY_TAG } from '../models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from '../models/creditCard.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../models/currencyRate.js';
import { DASHBOARD_ENTITY_TAG } from '../models/dashboard.js';
import { SETTINGS_ENTITY_TAG } from '../models/locale.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from '../models/merchant.js';
import { RECURRING_ENTITY_TAG } from '../models/recurring.js';
import { TAG_ENTITY_TAG } from '../models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../models/transaction.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../models/transactionTag.js';

/**
 * Composition root for everything a running FinTrack process needs on top of an open database: the repos the
 * controllers read through, the appliers the effect runner writes through, and the change bus. Shared by the server
 * (`main.ts`) and by `fintrack login`, which serves the sign-in page from a temporary server of its own when none is
 * running — one assembly, so the two can never wire a flow differently.
 */
export type Runtime = {
  deps: Deps;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
  resetLocale: () => void;
  changeBus: ChangeBus;
};

export type RuntimeConfig = Pick<Config, 'FINTRACK_LOCALE' | 'FIAT_RATE_STALE_HOURS' | 'CRYPTO_RATE_STALE_HOURS'>;

// stderr only — stdout carries the MCP protocol on the stdio transport (ADR-007).
const reportChangeError = (cause: unknown): void => {
  console.error('[fintrack] change notification failed:', cause);
};

export const createRuntime = (db: Db, config: RuntimeConfig): Runtime => {
  const settings = settingsRepo(db);
  const localeResolver = createLocaleResolver(settings, config.FINTRACK_LOCALE);

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
    settings,
    tags: tagsRepo(db),
    transactions: transactionsRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    locale: localeResolver.locale,
    rateStaleness: { fiatHours: config.FIAT_RATE_STALE_HOURS, cryptoHours: config.CRYPTO_RATE_STALE_HOURS },
  };

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
    ...AUTH_APPLIERS,
  };

  const changeBus = createChangeBus({ onError: reportChangeError });
  const engineContext = createEngineContext(db, reportChangeError);
  return {
    deps,
    runEffects: (flow) => runEffects(engineContext, applierRegistry, flow, changeBus.publish),
    runEffectsSequence: (items, flowFor) =>
      runEffectsSequence(engineContext, applierRegistry, items, flowFor, changeBus.publish),
    resetLocale: localeResolver.resetLocale,
    changeBus,
  };
};
