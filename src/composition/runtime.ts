import { randomUUID } from 'node:crypto';
import { createChangeBus, runEffects, runEffectsSequence, type ChangeBus } from '@rfc0/effect-runner';
import { AUTH_APPLIERS } from './auth.js';
import type { Config } from '../config.js';
import type { Deps, RunEffects, Tenancy } from '../controllers/deps.js';
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
import { settingsRepo, userSettingsApplier } from '../diplomat/db/repos/settings.js';
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
import { USER_SETTINGS_ENTITY_TAG } from '../models/locale.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from '../models/merchant.js';
import { RECURRING_ENTITY_TAG } from '../models/recurring.js';
import { TAG_ENTITY_TAG } from '../models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../models/transaction.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../models/transactionTag.js';
import type { ChangeEvent } from '../models/tenancy.js';

/**
 * Composition root for everything a running FinTrack process needs on top of an open database: the repos the
 * controllers read through, the appliers the effect runner writes through, and the change bus. Shared by the server
 * (`main.ts`) and by `fintrack login`, which serves the sign-in page from a temporary server of its own when none is
 * running — one assembly, so the two can never wire a flow differently.
 *
 * Tenancy (ADR-033 §5): nothing here is bound to a user. `depsFor(principal)` and the other factories build, for ONE
 * request, repos and appliers already bound to that principal's user by partial application, and the request drops
 * them when it ends. The only unscoped access is `authRunEffects` (the identity flows) and `publicDeps` (the
 * unauthenticated health probe) — which touch no user-owned table.
 */
export type Runtime = Tenancy & {
  /** The unauthenticated liveness probe's dependencies (ADR-033 §6): the database check, nothing of any user's. */
  publicDeps: Pick<Deps, 'health'>;
  /** Runs the identity flows (users, sessions, tokens, setup codes, sign-in grants) — not tied to a user's data. */
  authRunEffects: RunEffects;
  changeBus: ChangeBus<ChangeEvent>;
};

export type RuntimeConfig = Pick<Config, 'FINTRACK_LOCALE' | 'FIAT_RATE_STALE_HOURS' | 'CRYPTO_RATE_STALE_HOURS'>;

// stderr only — stdout carries the MCP protocol on the stdio transport (ADR-007).
const reportChangeError = (cause: unknown): void => {
  console.error('[fintrack] change notification failed:', cause);
};

/** The appliers of one user: every owned entity's applier is built for that user, so a write the user's flow returns
 *  can only ever insert their rows and touch their rows. Shared reference data (exchange rates, the merchant
 *  dictionary) has no owner and is registered as it is. */
const applierRegistryFor = (userId: string): ApplierRegistry => ({
  [ACCOUNT_ENTITY_TAG]: accountApplier(userId),
  [TRANSACTION_ENTITY_TAG]: transactionApplier(userId),
  [TRANSACTION_TAG_ENTITY_TAG]: transactionTagApplier(userId),
  [MERCHANT_ENTITY_TAG]: merchantApplier,
  [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier(userId),
  [BILL_ENTITY_TAG]: billApplier(userId),
  [BUDGET_ENTITY_TAG]: budgetApplier(userId),
  [TAG_ENTITY_TAG]: tagApplier(userId),
  [CATEGORY_ENTITY_TAG]: categoryApplier(userId),
  [CREDIT_CARD_ENTITY_TAG]: creditCardApplier(userId),
  [CURRENCY_RATE_ENTITY_TAG]: currencyRateApplier,
  [RECURRING_ENTITY_TAG]: recurringRuleApplier(userId),
  [DASHBOARD_ENTITY_TAG]: dashboardApplier(userId),
  [USER_SETTINGS_ENTITY_TAG]: userSettingsApplier(userId),
});

export type RuntimeOptions = {
  /** Where a failing change notification is reported (default: stderr). */
  onChangeError?: (cause: unknown) => void;
  /** The time every request's dependencies read (default: the system clock); a test pins it for determinism. */
  clock?: () => Date;
};

export const createRuntime = (db: Db, config: RuntimeConfig, options: RuntimeOptions = {}): Runtime => {
  const onChangeError = options.onChangeError ?? reportChangeError;
  const localeResolver = createLocaleResolver(config.FINTRACK_LOCALE);
  const changeBus = createChangeBus<ChangeEvent>({ onError: onChangeError });
  const engineContext = createEngineContext(db, onChangeError);
  const health = healthRepo(db);

  const depsFor: Tenancy['depsFor'] = ({ userId }) => {
    const settings = settingsRepo(db, userId);
    return {
      accounts: accountsRepo(db, userId),
      bills: billsRepo(db, userId),
      budgets: budgetsRepo(db, userId),
      categories: categoriesRepo(db, userId),
      subCategories: subCategoriesRepo(db, userId),
      correlations: correlationsRepo(db, userId),
      creditCards: creditCardsRepo(db, userId),
      currencies: currenciesRepo(db),
      currencyRates: currencyRatesRepo(db),
      dashboards: dashboardsRepo(db, userId),
      health,
      merchants: merchantsRepo(db, userId),
      recurring: recurringRepo(db, userId),
      settings,
      tags: tagsRepo(db, userId),
      transactions: transactionsRepo(db, userId),
      clock: options.clock ?? (() => new Date()),
      newId: () => randomUUID(),
      locale: () => localeResolver.locale(userId, settings),
      rateStaleness: { fiatHours: config.FIAT_RATE_STALE_HOURS, cryptoHours: config.CRYPTO_RATE_STALE_HOURS },
    };
  };

  // A committed write is announced as that user's: the bus carries who it belongs to.
  const publishFor =
    (userId: string | null) =>
    (entities: readonly string[]): void =>
      changeBus.publish({ userId, entities });

  return {
    publicDeps: { health },
    depsFor,
    runEffectsFor: ({ userId }) => {
      const registry = applierRegistryFor(userId);
      return (flow) => runEffects(engineContext, registry, flow, publishFor(userId));
    },
    runEffectsSequenceFor: ({ userId }) => {
      const registry = applierRegistryFor(userId);
      return (items, flowFor) => runEffectsSequence(engineContext, registry, items, flowFor, publishFor(userId));
    },
    resetLocaleFor: ({ userId }) => localeResolver.resetLocale(userId),
    authRunEffects: (flow) => runEffects(engineContext, AUTH_APPLIERS, flow, publishFor(null)),
    changeBus,
  };
};
