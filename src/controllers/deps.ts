import type { Result, ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import type { FlowOutcome } from '../models/persistable.js';
import type { Locale } from '../models/locale.js';
import type { AccountsRepo } from '../diplomat/db/repos/accounts.js';
import type { BillsRepo } from '../diplomat/db/repos/bills.js';
import type { BudgetsRepo } from '../diplomat/db/repos/budgets.js';
import type { CategoriesRepo } from '../diplomat/db/repos/categories.js';
import type { SubCategoriesRepo } from '../diplomat/db/repos/subCategories.js';
import type { CreditCardsRepo } from '../diplomat/db/repos/creditCards.js';
import type { DashboardsRepo } from '../diplomat/db/repos/dashboards.js';
import type { HealthRepo } from '../diplomat/db/repos/health.js';
import type { MerchantsRepo } from '../diplomat/db/repos/merchants.js';
import type { RecurringRepo } from '../diplomat/db/repos/recurring.js';
import type { SettingsRepo } from '../diplomat/db/repos/settings.js';
import type { TagsRepo } from '../diplomat/db/repos/tags.js';
import type { TransactionsRepo } from '../diplomat/db/repos/transactions.js';

/** Side-effect dependencies, injected so controllers stay testable. */
export type Deps = {
  accounts: AccountsRepo;
  bills: BillsRepo;
  budgets: BudgetsRepo;
  categories: CategoriesRepo;
  subCategories: SubCategoriesRepo;
  creditCards: CreditCardsRepo;
  dashboards: DashboardsRepo;
  health: HealthRepo;
  merchants: MerchantsRepo;
  recurring: RecurringRepo;
  settings: SettingsRepo;
  tags: TagsRepo;
  transactions: TransactionsRepo;
  clock: () => Date;
  newId: () => string;
  locale: () => Promise<Locale>;
};

/**
 * The imperative shell's capability to run a functional-core flow (docs/functional-core-imperative-shell.md):
 * invoke `flow`, execute the effects it returns, and yield the response. Not a field on `Deps` —
 * `Deps` is handed to controllers, and this is shell-only (only diplomat handlers call it), so a
 * controller can never reach for it and apply its own writes. The concrete implementation
 * (`runEffects`, bound to a `Db`) lives in `diplomat/db`; this is just the shape
 * `diplomat/mcp`/`diplomat/http` depend on.
 */
export type RunEffects = <T>(flow: () => ResultAsync<FlowOutcome<T>, AppError>) => ResultAsync<T, AppError>;

/**
 * The imperative shell's capability to run a **sequence** of independent per-item flows: each
 * item's flow runs and applies in its own transaction, in commit order, so item *i+1*'s flow sees
 * item *i*'s committed writes; one item's failure is recorded and the sequence continues (partial
 * success). Shell-only, like `RunEffects` — never a field a controller can reach for. The concrete
 * implementation (`runEffectsSequence`, bound to a `Db`) lives in `diplomat/db`; this is just the
 * shape `diplomat/mcp`/`diplomat/http` depend on.
 */
export type RunEffectsSequence = <I, T>(
  items: readonly I[],
  flowFor: (item: I) => () => ResultAsync<FlowOutcome<T>, AppError>,
) => Promise<Result<T, AppError>[]>;
