import * as R from 'remeda';
import { err, ok, type Result, type ResultAsync } from 'neverthrow';
import type { FlowOutcome } from '@rfc0/effect-runner';
import * as demoAdapters from '../adapters/demo.js';
import { formatAppError, type AppError } from '../common/errors.js';
import { addAccountExpense, addAccountIncome } from '../controllers/account/transaction.js';
import { createAccount } from '../controllers/account/account.js';
import { createTransfer } from '../controllers/account/transfer.js';
import { createBudget } from '../controllers/budgets.js';
import { payBill, revertBillPayment } from '../controllers/credit-card/bill.js';
import { createCreditCard } from '../controllers/credit-card/credit-card.js';
import { addCardPurchase } from '../controllers/credit-card/transaction.js';
import { setExchangeRate } from '../controllers/currency-rates.js';
import { scopedFor, type Deps, type Scoped } from '../controllers/deps.js';
import { markDemoInstance } from '../controllers/instance.js';
import { applyDueRecurring, createRecurring } from '../controllers/recurring.js';
import { setBaseCurrency, setLocale } from '../controllers/settings.js';
import { createTag } from '../controllers/tags.js';
import type { Db } from '../diplomat/db/driver.js';
import { instanceSettingsRepo } from '../diplomat/db/repos/instance-settings.js';
import { DEMO_PACKS } from '../diplomat/db/seed/demo/index.js';
import { clockDateOf, planDemo } from '../logic/demo.js';
import { toIsoDate } from '../logic/period.js';
import { OWNER_PRINCIPAL } from '../models/auth/principal.js';
import { demoErrors, DemoStepKind, type DemoCountry, type DemoSeedReport, type DemoStep } from '../models/demo.js';
import { isDemoInstance } from '../models/instance.js';
import { TransactionSource } from '../models/transaction.js';
import { bindAuthRunEffects } from './auth.js';
import { createRuntime, type RuntimeConfig } from './runtime.js';

/**
 * Composition root of the demo seed: runs the generator's plan (`logic/demo.ts`) through the same write flows the MCP
 * tools and REST routes run — one runner, the clock set to each item's date — so bills, idempotency keys,
 * classification and merchant learning behave exactly as in real use. No demo-only write path, no raw SQL.
 */

const SOURCE = TransactionSource.enum.mcp;
const NOON = 12;

export type DemoSeedOptions = {
  country: DemoCountry;
  today: Date;
  config: Pick<RuntimeConfig, 'FIAT_RATE_STALE_HOURS' | 'CRYPTO_RATE_STALE_HOURS'>;
};

type Step<Kind extends DemoStepKind> = Extract<DemoStep, { kind: Kind }>;
type Handlers = { [Kind in DemoStepKind]: (scoped: Scoped, step: Step<Kind>) => ResultAsync<unknown, AppError> };

const run = <T>(scoped: Scoped, flow: (deps: Deps) => ResultAsync<FlowOutcome<T>, AppError>) =>
  scoped.runEffects(() => flow(scoped.deps).map(demoAdapters.outcomeToDb));

const K = DemoStepKind.enum;

const HANDLERS: Handlers = {
  [K.locale]: (scoped, { input }) => run(scoped, (deps) => setLocale(deps, input)).map(() => scoped.resetLocale()),
  [K.baseCurrency]: (scoped, { input }) => run(scoped, (deps) => setBaseCurrency(deps, input)),
  [K.account]: (scoped, { input }) => run(scoped, (deps) => createAccount(deps, input)),
  [K.card]: (scoped, { input }) => run(scoped, (deps) => createCreditCard(deps, input)),
  [K.tag]: (scoped, { name }) => run(scoped, (deps) => createTag(deps, name)),
  [K.rate]: (scoped, { input }) => run(scoped, (deps) => setExchangeRate(deps, input)),
  [K.recurring]: (scoped, { input }) => run(scoped, (deps) => createRecurring(deps, input)),
  [K.budget]: (scoped, { input }) => run(scoped, (deps) => createBudget(deps, input)),
  [K.expense]: (scoped, { input }) => run(scoped, (deps) => addAccountExpense(deps, input, SOURCE)),
  [K.income]: (scoped, { input }) => run(scoped, (deps) => addAccountIncome(deps, input, SOURCE)),
  [K.purchase]: (scoped, { input }) => run(scoped, (deps) => addCardPurchase(deps, input, SOURCE)),
  [K.transfer]: (scoped, { input }) => run(scoped, (deps) => createTransfer(deps, input, SOURCE)),
  [K.applyDue]: (scoped, { through }) => run(scoped, (deps) => applyDueRecurring(deps, { through })),
  [K.payBill]: (scoped, { input }) => run(scoped, (deps) => payBill(deps, { ...input, source: SOURCE })),
  [K.revertBill]: (scoped, { input }) => run(scoped, (deps) => revertBillPayment(deps, input)),
};

// The one cast: TypeScript cannot correlate `step.kind` with the handler picked by it; `Handlers` proves each has one.
const runStep = (scoped: Scoped, step: DemoStep): ResultAsync<unknown, AppError> =>
  (HANDLERS[step.kind] as (scoped: Scoped, step: DemoStep) => ResultAsync<unknown, AppError>)(scoped, step);

const failedStep = (step: DemoStep, error: AppError): AppError =>
  demoErrors.stepFailed(step.kind, step.date, formatAppError(error));

const noonOf = (isoDate: string): Date => {
  const [year = 0, month = 1, day = 1] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day, NOON);
};

/**
 * Seeds `db` as a demo for `country`, relative to `today`. A fresh database is marked `demo` first (the marker, not a
 * path, says it is one) and then filled. A database that already holds data is left alone when it is a demo (so running
 * the demo again does not duplicate anything) and refused when it is not.
 */
export const seedDemo = async (db: Db, options: DemoSeedOptions): Promise<Result<DemoSeedReport, AppError>> => {
  const clock = { now: options.today };
  const runtime = createRuntime(db, { ...options.config, FINTRACK_LOCALE: undefined }, { clock: () => clock.now });
  const scoped = scopedFor(runtime, OWNER_PRINCIPAL);

  if ((await scoped.deps.accounts.list()).length > 0) {
    return isDemoInstance(await runtime.instanceKind())
      ? ok({ seeded: false, steps: {} })
      : err(demoErrors.notDemoDatabase);
  }

  const marked = await bindAuthRunEffects(runtime.authRunEffects)(() =>
    markDemoInstance({ instanceSettings: instanceSettingsRepo(db) }),
  );
  if (marked.isErr()) return err(marked.error);

  const today = toIsoDate(options.today);
  const plan = planDemo(DEMO_PACKS[options.country], today);
  for (const step of plan) {
    clock.now = noonOf(clockDateOf(step, today));
    const result = await runStep(scoped, step);
    if (result.isErr()) return err(failedStep(step, result.error));
  }
  return ok({ seeded: true, steps: R.countBy(plan, (step) => step.kind) });
};
