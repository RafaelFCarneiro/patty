import type { Result, ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { Principal } from '../models/auth/principal.js';
import type { Presentation, SignInConfig, SignInObservation, SignInState } from '../models/auth/signInFlow.js';
import type { ClientConfigFailure } from '../models/clientConfig.js';
import type { KeychainFailure } from '../models/auth/signIn.js';
import type { Locale } from '../models/locale.js';
import type { AccountsRepo } from '../diplomat/db/repos/accounts.js';
import type { BillsRepo } from '../diplomat/db/repos/bills.js';
import type { BudgetsRepo } from '../diplomat/db/repos/budgets.js';
import type { CategoriesRepo } from '../diplomat/db/repos/categories.js';
import type { SubCategoriesRepo } from '../diplomat/db/repos/subCategories.js';
import type { CorrelationsRepo } from '../diplomat/db/repos/correlations.js';
import type { CreditCardsRepo } from '../diplomat/db/repos/creditCards.js';
import type { CurrenciesRepo } from '../diplomat/db/repos/currencies.js';
import type { CurrencyRatesRepo } from '../diplomat/db/repos/currencyRates.js';
import type { DashboardsRepo } from '../diplomat/db/repos/dashboards.js';
import type { HealthRepo } from '../diplomat/db/repos/health.js';
import type { MerchantsRepo } from '../diplomat/db/repos/merchants.js';
import type { RecurringRepo } from '../diplomat/db/repos/recurring.js';
import type { SettingsRepo } from '../diplomat/db/repos/settings.js';
import type { TagsRepo } from '../diplomat/db/repos/tags.js';
import type { AccessTokensRepo } from '../diplomat/db/repos/accessTokens.js';
import type { ClientGrantsRepo } from '../diplomat/db/repos/clientGrants.js';
import type { InstanceSettingsRepo } from '../diplomat/db/repos/instanceSettings.js';
import type { InvitesRepo } from '../diplomat/db/repos/invites.js';
import type { SessionsRepo } from '../diplomat/db/repos/sessions.js';
import type { SetupCodesRepo } from '../diplomat/db/repos/setupCodes.js';
import type { TransactionsRepo } from '../diplomat/db/repos/transactions.js';
import type { UsersRepo } from '../diplomat/db/repos/users.js';
import { StalenessThresholds } from '../models/currencyRate.js';

export type Deps = {
  accounts: AccountsRepo;
  bills: BillsRepo;
  budgets: BudgetsRepo;
  categories: CategoriesRepo;
  subCategories: SubCategoriesRepo;
  correlations: CorrelationsRepo;
  creditCards: CreditCardsRepo;
  currencies: CurrenciesRepo;
  currencyRates: CurrencyRatesRepo;
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
  rateStaleness: StalenessThresholds;
};

export type AuthSecrets = {
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (hash: string, password: string) => Promise<boolean>;
  randomToken: () => string;
  randomAccessToken: () => string;
  randomSetupCode: () => string;
  randomUserCode: () => string;
  randomInviteCode: () => string;
  randomDeviceCode: () => string;
  hashSecret: (secret: string) => string;
  dummyPasswordHash: string;
};

export type SignInStore = {
  load: () => ResultAsync<string | null, KeychainFailure>;
  save: (token: string) => Promise<boolean>;
  clear: () => Promise<void>;
};

export type SignInServer = { origin: string; close: () => Promise<void> };

export type ClientSetupReport = {
  warnings: readonly string[];
  lines: readonly string[];
};

export type ClientConfig = {
  label: string;
  run: (profile: string) => Result<ClientSetupReport, ClientConfigFailure>;
};

export type ClientConfigs = {
  find: (tool: string) => ClientConfig | undefined;
};

export type SignInHooks = {
  present: (presentation: Presentation) => void;
  wait: (ms: number) => Promise<void>;
  progress: (state: SignInState) => void;
};

export type SignInInterpreter = {
  drive: (
    state: SignInState,
    observation: SignInObservation,
    config: SignInConfig,
    hooks: SignInHooks,
  ) => Promise<SignInState>;
  release: () => Promise<void>;
};

export type AuthDeps = {
  users: UsersRepo;
  sessions: SessionsRepo;
  accessTokens: AccessTokensRepo;
  clientGrants: ClientGrantsRepo;
  invites: InvitesRepo;
  instanceSettings: InstanceSettingsRepo;
  setupCodes: SetupCodesRepo;
  clock: () => Date;
  newId: () => string;
  secrets: AuthSecrets;
};

export type RunEffects = <T>(flow: () => ResultAsync<FlowOutcome<T>, AppError>) => ResultAsync<T, AppError>;

export type RunEffectsSequence = <I, T>(
  items: readonly I[],
  flowFor: (item: I) => () => ResultAsync<FlowOutcome<T>, AppError>,
) => Promise<Result<T, AppError>[]>;

export type Scoped = {
  deps: Deps;
  runEffects: RunEffects;
  runEffectsSequence: RunEffectsSequence;
  resetLocale: () => void;
};

export type Tenancy = {
  depsFor: (principal: Principal) => Deps;
  runEffectsFor: (principal: Principal) => RunEffects;
  runEffectsSequenceFor: (principal: Principal) => RunEffectsSequence;
  resetLocaleFor: (principal: Principal) => void;
};

export const scopedFor = (tenancy: Tenancy, principal: Principal): Scoped => ({
  deps: tenancy.depsFor(principal),
  runEffects: tenancy.runEffectsFor(principal),
  runEffectsSequence: tenancy.runEffectsSequenceFor(principal),
  resetLocale: () => tenancy.resetLocaleFor(principal),
});
