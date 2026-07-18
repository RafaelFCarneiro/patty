import type { ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import type { FlowOutcome } from '../models/persistable.js';
import type { Locale } from '../models/locale.js';
import type { AccountsRepo } from '../diplomat/db/repos/accounts.js';
import type { BillsRepo } from '../diplomat/db/repos/bills.js';
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
  resetLocale: () => void;
};

/**
 * The imperative shell's capability to run a functional-core flow
 * (docs/functional-core-imperative-shell.md): invoke `flow`, execute the effects it returns, and
 * yield the flow's `response`. Not a field on `Deps` — `Deps` is handed to controllers, and a
 * `RunEffects` runner is a shell-only concern (only diplomat handlers call it, wrapping a
 * controller invocation); keeping the two separate means a controller can never reach for it and
 * apply its own writes. The concrete implementation (`runEffects`, bound to a `Db`) lives in
 * `diplomat/db` — this is just the shape the shell's edges (`diplomat/mcp`, `diplomat/http`)
 * depend on.
 */
export type RunEffects = <T>(flow: () => ResultAsync<FlowOutcome<T>, AppError>) => ResultAsync<T, AppError>;
