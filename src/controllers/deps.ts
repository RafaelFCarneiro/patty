import type { Result, ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import type { StalenessThresholds } from '../logic/currencyRate.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { Presentation, SignInConfig, SignInObservation, SignInState } from '../models/auth/signInFlow.js';
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
import type { SessionsRepo } from '../diplomat/db/repos/sessions.js';
import type { SetupCodesRepo } from '../diplomat/db/repos/setupCodes.js';
import type { TransactionsRepo } from '../diplomat/db/repos/transactions.js';
import type { UsersRepo } from '../diplomat/db/repos/users.js';

/** Side-effect dependencies, injected so controllers stay testable. */
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

/** Secrets and randomness, injected so `logic/` and controllers stay deterministic and testable. The
 *  real implementations (argon2id, CSPRNG, sha256) live in `diplomat/auth/credentials.ts`. */
export type AuthSecrets = {
  hashPassword: (password: string) => Promise<string>;
  /** Constant-time; resolves `false` (never throws) for a mismatch or an unreadable hash. */
  verifyPassword: (hash: string, password: string) => Promise<boolean>;
  /** A fresh opaque session token (256 random bits, base64url). */
  randomToken: () => string;
  /** A fresh personal access token: `ftk_` + 256 random bits (base64url). Shown once, never stored. */
  randomAccessToken: () => string;
  /** The raw characters of a fresh setup code, before display grouping. */
  randomSetupCode: () => string;
  /** The raw characters of a fresh sign-in user code (8 symbols), before display grouping. */
  randomUserCode: () => string;
  /** A fresh device code (256 random bits, base64url) — held by the asking process, stored only as a hash. */
  randomDeviceCode: () => string;
  /** sha256 of a secret — what is stored instead of the session token or setup code. */
  hashSecret: (secret: string) => string;
  /** A real hash nobody holds the password for — verified against when the user does not exist, so an
   *  unknown username takes as long as a wrong password (ADR-033 §2). */
  dummyPasswordHash: string;
};

/** Where a saved stdio sign-in lives between runs — the OS keychain in production (ADR-034 §2). Keychain trouble
 *  A refused write is reported by returning `false`, after which the sign-in lasts only as long as the process; an
 *  unreadable store is `KeychainUnavailableError` from `load`, which each caller decides how to treat (the stdio
 *  session carries on without a saved sign-in, `logout` refuses to claim a sign-out it could not check). */
export type SignInStore = {
  /** `null` = nothing saved. Throws `KeychainUnavailableError` when the keychain cannot be read at all. */
  load: () => Promise<string | null>;
  save: (token: string) => Promise<boolean>;
  clear: () => Promise<void>;
};

/** Where the consent page is served while a sign-in waits: a temporary server this process started on its own. */
export type SignInServer = { origin: string; close: () => Promise<void> };

/** One MCP client whose configuration file `setup` knows how to write. */
export type ClientConfig = {
  label: string;
  /** Writes (or prints) the entry that runs FinTrack as `profile` for this client. */
  run: (profile: string) => void;
};

/** The clients `setup` can configure — the config files of Claude Code, Claude Desktop, VS Code…, behind one lookup. */
export type ClientConfigs = {
  /** The client named `tool` (trimmed, case-insensitive), or `undefined` for a name nothing answers to. */
  find: (tool: string) => ClientConfig | undefined;
};

/** What the edge supplies each time it feeds the sign-in protocol: where facts for the person go, and how to wait. */
export type SignInHooks = {
  present: (presentation: Presentation) => void;
  /** Resolves after `ms`, or sooner if the edge has reason to look again; an edge that paces itself returns now. */
  wait: (ms: number) => Promise<void>;
  /** The state after each step, so an edge that loses the drive to a throw still knows how far it got. */
  progress: (state: SignInState) => void;
};

/**
 * The imperative shell's capability to run the sign-in protocol (`logic/auth/signInFlow.ts` decides, this executes).
 * `drive` feeds one observation and runs the effects it leads to — each answer fed straight back — until nothing is
 * left to do, then returns the state. Not a controller (it executes effects, which controllers never do), and built at
 * the composition root (`src/composition/signIn/interpreter.ts`) like `RunEffects`, so no edge imports another.
 */
export type SignInInterpreter = {
  drive: (
    state: SignInState,
    observation: SignInObservation,
    config: SignInConfig,
    hooks: SignInHooks,
  ) => Promise<SignInState>;
  /** Close the temporary page, if one is open. Idempotent; for an edge that ends without the protocol finishing. */
  release: () => Promise<void>;
};

/** Identity dependencies (ADR-033): kept apart from `Deps` because auth is infrastructure the domain
 *  controllers never see — only `controllers/auth.ts` and the HTTP edge's auth hook use these. */
export type AuthDeps = {
  users: UsersRepo;
  sessions: SessionsRepo;
  accessTokens: AccessTokensRepo;
  clientGrants: ClientGrantsRepo;
  setupCodes: SetupCodesRepo;
  clock: () => Date;
  newId: () => string;
  secrets: AuthSecrets;
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
