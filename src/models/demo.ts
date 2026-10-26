import { z } from 'zod';
import { InstanceKind } from './instance.js';
import type { AddAccountMovement, CreateAccount, CreateTransfer } from './account.js';
import type { BillQuery, PayBill } from './bill.js';
import type { CreateBudget } from './budget.js';
import type { CreateCreditCard, AddCardPurchase } from './credit-card.js';
import type { SetExchangeRateInput } from './currency-rate.js';
import type { Locale, SetBaseCurrencyInput, SetLocaleInput } from './locale.js';
import type { CurrencyCode } from './money.js';
import type { CreateRecurring } from './recurring.js';
import { validation, type ValidationError } from './error.js';
import { NPX_COMMAND } from './package.js';

/** The four data sets a demo can be generated for. A language alone cannot choose: Spanish has two. */
export const DemoCountry = z.enum(['br', 'us', 'mx', 'co']);
export type DemoCountry = z.infer<typeof DemoCountry>;
export const DEFAULT_DEMO_COUNTRY = DemoCountry.enum.us;

/** The demo's fixed, published encryption key. The data is fake and public, so the key protects nothing — and saying so
 *  beats a keychain entry that implies otherwise. A real database never opens with it (it has its own key), and the
 *  demo never prompts for keychain access. */
export const DEMO_DB_KEY = '0123456789abcdef'.repeat(4);

/** The demo's sidecar port. Next to the real install's `51737`, so both can run at once. */
export const DEMO_PORT = 51738;

/** The MCP entry `setup <client> --demo` adds, beside (never instead of) `fintrack`. */
export const DEMO_SERVER_NAME = 'fintrack-demo';

/** The environment switch that makes a process use the demo key with auth off. The database's own marker is still
 *  what says "this is a demo" — this only selects how to open it. */
export const DEMO_ENV_VAR = 'FINTRACK_DEMO';
export const DEMO_ENV_ON = '1';

/** Said when a process told to open the demo finds a database that is not one: it never serves it. */
export const demoNotReadyMessage = (dbPath: string): string =>
  `fintrack: ${DEMO_ENV_VAR} is set, but ${dbPath} is not a demo database. Create it with: ${NPX_COMMAND} demo`;

/** Where a generated purchase comes from. The pack names the accounts and cards; the generator maps these to them. */
export const DemoFunding = z.enum(['checking', 'wallet', 'primaryCard', 'secondaryCard', 'global']);
export type DemoFunding = z.infer<typeof DemoFunding>;

export type DemoAccountSpec = { name: string; initialBalance: number };
export type DemoCardSpec = { name: string; closingDay: number; dueDay: number; limit: number };

/** A merchant a person keeps going back to: `perMonth` purchases a month, each between `min` and `max`. */
export type DemoSpendLine = {
  description: string;
  category: string;
  via: DemoFunding;
  min: number;
  max: number;
  perMonth: number;
  tag?: string;
};

/** A fixed amount on a fixed day of the month (salary, rent, a subscription). */
export type DemoFixedLine = { description: string; category: string; amount: number; day: number };

export type DemoTransferLine = { description: string; amount: number };

/** Something expected but not yet real: `daysAhead` days after today, so it is `pending` until confirmed. */
export type DemoPendingLine = {
  description: string;
  category: string;
  via: DemoFunding;
  amount: number;
  daysAhead: number;
  income?: boolean;
};

/** One purchase of the trip: no tag, spread over several categories and funding sources on purpose. */
export type DemoTripItem = {
  description: string;
  category: string;
  via: DemoFunding;
  amount: number;
  dayOffset: number;
};

/** How much of last month's spend a category's budget allows: under 1 is a budget the month already blew. */
export type DemoBudgetShape = { category: string; factor: number };

/** Everything country-specific, as data. The generator's rules (cadence, distribution) are shared by all four. */
export type DemoPack = {
  country: DemoCountry;
  locale: Locale;
  currency: CurrencyCode;
  /** Amounts are rounded to a multiple of this (COP has no practical cents; BRL does). */
  amountStep: number;
  /** Base-currency units per US dollar: prices the USDC/BTC positions and the dollar account for the demo. */
  usdRate: number;
  accounts: {
    checking: DemoAccountSpec;
    savings: DemoAccountSpec;
    investment: DemoAccountSpec;
    wallet: DemoAccountSpec;
    usdc: DemoAccountSpec;
    btc: DemoAccountSpec;
  };
  /** A second-currency (USD) account with a few dollar purchases — only some packs have one. */
  global?: DemoAccountSpec & { spending: readonly DemoSpendLine[] };
  cards: { primary: DemoCardSpec; secondary: DemoCardSpec };
  tags: readonly string[];
  salary: DemoFixedLine;
  rent: DemoFixedLine;
  subscriptions: readonly DemoFixedLine[];
  freelance: DemoFixedLine;
  spending: readonly DemoSpendLine[];
  transfers: { savings: DemoTransferLine; investment: DemoTransferLine; wallet: DemoTransferLine };
  pending: readonly DemoPendingLine[];
  budgets: readonly DemoBudgetShape[];
  trip: { destination: string; items: readonly DemoTripItem[] };
};

export const DemoStepKind = z.enum([
  'locale',
  'baseCurrency',
  'account',
  'card',
  'tag',
  'rate',
  'recurring',
  'budget',
  'expense',
  'income',
  'purchase',
  'transfer',
  'applyDue',
  'payBill',
  'revertBill',
]);
export type DemoStepKind = z.infer<typeof DemoStepKind>;

type StepOf<Kind extends DemoStepKind, Payload> = { kind: Kind; date: string } & Payload;

/** One write the seeder runs through the real flow of the same name, with the clock set to `date`. */
export type DemoStep =
  | StepOf<'locale', { input: SetLocaleInput }>
  | StepOf<'baseCurrency', { input: SetBaseCurrencyInput }>
  | StepOf<'account', { input: CreateAccount }>
  | StepOf<'card', { input: CreateCreditCard }>
  | StepOf<'tag', { name: string }>
  | StepOf<'rate', { input: SetExchangeRateInput }>
  | StepOf<'recurring', { input: CreateRecurring }>
  | StepOf<'budget', { input: CreateBudget }>
  | StepOf<'expense', { input: AddAccountMovement }>
  | StepOf<'income', { input: AddAccountMovement }>
  | StepOf<'purchase', { input: AddCardPurchase }>
  | StepOf<'transfer', { input: CreateTransfer }>
  | StepOf<'applyDue', { through: string }>
  | StepOf<'payBill', { input: PayBill }>
  | StepOf<'revertBill', { input: BillQuery }>;

/** How a seed run ended. `present` is a demo seeded in full earlier; `interrupted` one whose seed never finished (the
 *  completion marker is missing); `not_demo` a database that holds data and is not marked a demo. */
export const DemoSeedStatus = z.enum(['seeded', 'present', 'interrupted', 'not_demo']);
export type DemoSeedStatus = z.infer<typeof DemoSeedStatus>;

/** What a seed run did, per kind of write. */
export type DemoSeedReport = { status: DemoSeedStatus; steps: Partial<Record<DemoStepKind, number>> };

export const demoErrors = {
  stepFailed: (kind: DemoStepKind, date: string, reason: string): ValidationError =>
    validation([`demo seed failed at ${kind} (${date}): ${reason}`]),
};

/** Why `demo` did not start. `real_database`: the demo path is the real `DB_PATH`. `not_demo`: a file there that is
 *  not a demo database (or does not open with the demo key) — never deleted, never seeded. `interrupted`: a demo whose
 *  seed never finished. `seed_failed`: a seed that stopped on a step. `port_in_use`: the demo's port is taken. */
export const DemoFailureCode = z.enum(['real_database', 'not_demo', 'interrupted', 'seed_failed', 'port_in_use']);
export type DemoFailureCode = z.infer<typeof DemoFailureCode>;
export type DemoFailure = { code: DemoFailureCode; reason: string };

export const demoFailures = {
  of: (code: DemoFailureCode, reason = ''): DemoFailure => ({ code, reason }),
};

/** What a look at the demo path found, before anything is migrated, seeded or deleted: no file, a file that does not
 *  open with the demo key (or is not a FinTrack database), or a database and what it says it is. */
export const DemoProbe = z.enum(['missing', 'unreadable']).or(InstanceKind);
export type DemoProbe = z.infer<typeof DemoProbe>;
