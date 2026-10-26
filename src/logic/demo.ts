import { createHash } from 'node:crypto';
import * as R from 'remeda';
import { billPeriodFor } from './bill.js';
import { roundToDecimals } from './money.js';
import { MovementType, TransactionStatus } from '../models/transaction.js';
import { AccountType } from '../models/account.js';
import type { BillPeriod } from '../models/bill.js';
import {
  DEFAULT_DEMO_COUNTRY,
  DemoCountry,
  DemoFunding,
  DemoStepKind,
  type DemoCardSpec,
  type DemoFixedLine,
  type DemoPack,
  type DemoPendingLine,
  type DemoSpendLine,
  type DemoStep,
  type DemoTripItem,
} from '../models/demo.js';
import { BudgetPeriod } from '../models/budget.js';
import { Locale, LocaleSource } from '../models/locale.js';
import { CurrencyCode, FIAT_DECIMALS } from '../models/money.js';
import { RecurringPeriod } from '../models/recurring.js';

/** The generator is a pure function of this seed, the country pack and today's date. */
export const DEMO_SEED = 'fintrack-demo';

/** The last four full months plus the current one, so the dashboards always look current. */
export const DEMO_MONTHS_BACK = 4;

/** One bitcoin in US dollars, for the demo's USDC/BTC position (a demo price, not a quote). */
export const DEMO_BTC_USD_PRICE = 100_000;
export const DEMO_RATE_SOURCE = 'demo';

const TRIP_MONTH_OFFSET = -2;
const TRIP_START_DAY = 10;
const FREELANCE_MONTH_OFFSETS: readonly number[] = [-3, -1];
const SAVINGS_TRANSFER_DAY = 6;
const INVESTMENT_TRANSFER_DAY = 7;
const WALLET_TRANSFER_DAY = 12;
const RATE_TIME = 'T12:00:00.000Z';
const SPEND_PREFIX = { main: 'main', global: 'global' } as const;
const STEP = DemoStepKind.enum;

type Month = { year: number; month: number };
/** A month of the window: `days` it has, `lastDay` it has reached (today's, for the current one). */
type MonthContext = Month & { offset: number; days: number; lastDay: number };

const pad = (n: number): string => String(n).padStart(2, '0');
const isoDate = (year: number, month: number, day: number): string => `${year}-${pad(month)}-${pad(day)}`;
const parseDate = (date: string): Month & { day: number } => {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return { year, month, day };
};
const daysInMonth = ({ year, month }: Month): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const shiftMonth = ({ year, month }: Month, delta: number): Month => {
  const index = year * 12 + (month - 1) + delta;
  const shiftedYear = Math.floor(index / 12);
  return { year: shiftedYear, month: index - shiftedYear * 12 + 1 };
};

const addDays = (date: string, days: number): string => {
  const { year, month, day } = parseDate(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return isoDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
};

const monthContext = (today: string, offset: number): MonthContext => {
  const now = parseDate(today);
  const shifted = shiftMonth(now, offset);
  const days = daysInMonth(shifted);
  return { ...shifted, offset, days, lastDay: offset === 0 ? Math.min(now.day, days) : days };
};

const windowOf = (today: string): readonly MonthContext[] =>
  R.range(-DEMO_MONTHS_BACK, 1).map((offset) => monthContext(today, offset));

const dateIn = (month: Month, day: number): string =>
  isoDate(month.year, month.month, Math.min(day, daysInMonth(month)));

/** A number in [0, 1) that depends only on the seed and the parts: the whole generator's source of "randomness". */
const unit = (...parts: ReadonlyArray<string | number>): number =>
  createHash('sha256')
    .update([DEMO_SEED, ...parts].join('|'))
    .digest()
    .readUInt32BE(0) /
  2 ** 32;

const roundToStep = (value: number, step: number): number =>
  roundToDecimals(Math.max(step, Math.round(value / step) * step), FIAT_DECIMALS);

const amountBetween = (pack: DemoPack, min: number, max: number, key: string): number =>
  roundToStep(min + unit(key, 'amount') * (max - min), pack.amountStep);

type Funding = { account: string } | { card: string };

const fundingOf = (pack: DemoPack, via: DemoFunding): Funding => {
  const byFunding = {
    [DemoFunding.enum.checking]: { account: pack.accounts.checking.name },
    [DemoFunding.enum.wallet]: { account: pack.accounts.wallet.name },
    [DemoFunding.enum.primaryCard]: { card: pack.cards.primary.name },
    [DemoFunding.enum.secondaryCard]: { card: pack.cards.secondary.name },
    [DemoFunding.enum.global]: { account: pack.global?.name ?? pack.accounts.checking.name },
  } satisfies Record<DemoFunding, Funding>;
  return byFunding[via];
};

type Spend = {
  description: string;
  category: string;
  amount: number;
  date: string;
  discriminator: string;
  tag?: string;
  pending?: boolean;
};

const optionalFields = ({ tag, pending }: Spend) => ({
  ...(tag ? { tags: [tag] } : {}),
  ...(pending ? { status: TransactionStatus.enum.pending } : {}),
});

const spendStep = (funding: Funding, spend: Spend): DemoStep => {
  const { description, category, amount, date, discriminator } = spend;
  const common = { description, category, amount, date, discriminator, ...optionalFields(spend) };
  return 'card' in funding
    ? { kind: STEP.purchase, date, input: { ...common, card: funding.card, type: MovementType.enum.expense } }
    : { kind: STEP.expense, date, input: { ...common, account: funding.account } };
};

const spendOccurrence =
  (pack: DemoPack, prefix: string, month: MonthContext, line: DemoSpendLine, lineIndex: number) =>
  (occurrence: number): DemoStep[] => {
    const key = [prefix, lineIndex, month.offset, occurrence].join('|');
    const day = 1 + Math.floor(unit(key, 'day') * month.days);
    if (day > month.lastDay) return [];
    const spend: Spend = {
      description: line.description,
      category: line.category,
      amount: amountBetween(pack, line.min, line.max, key),
      date: dateIn(month, day),
      discriminator: key,
      tag: line.tag,
    };
    return [spendStep(fundingOf(pack, line.via), spend)];
  };

const spendStepsOf = (
  pack: DemoPack,
  prefix: string,
  lines: readonly DemoSpendLine[],
  months: readonly MonthContext[],
): DemoStep[] =>
  R.flatMap(months, (month) =>
    R.flatMap(lines, (line, lineIndex) =>
      R.flatMap(R.range(0, line.perMonth), spendOccurrence(pack, prefix, month, line, lineIndex)),
    ),
  );

const tripStepsOf = (pack: DemoPack, today: string): DemoStep[] => {
  const start = dateIn(shiftMonth(parseDate(today), TRIP_MONTH_OFFSET), TRIP_START_DAY);
  return pack.trip.items.map((item: DemoTripItem, index) => {
    const date = addDays(start, item.dayOffset);
    const spend: Spend = {
      ...R.pick(item, ['description', 'category', 'amount']),
      date,
      discriminator: `trip|${index}`,
    };
    return spendStep(fundingOf(pack, item.via), spend);
  });
};

const pendingStepOf =
  (pack: DemoPack, today: string) =>
  (line: DemoPendingLine, index: number): DemoStep => {
    const date = addDays(today, line.daysAhead);
    const { description, category, amount } = line;
    const common = { description, category, amount, date, account: pack.accounts.checking.name };
    const input = { ...common, discriminator: `pending|${index}`, status: TransactionStatus.enum.pending };
    return { kind: line.income ? STEP.income : STEP.expense, date, input };
  };

const recurringStepOf =
  (pack: DemoPack, start: Month, type: MovementType) =>
  (line: DemoFixedLine): DemoStep => ({
    kind: STEP.recurring,
    date: dateIn(start, 1),
    input: {
      description: line.description,
      amount: line.amount,
      type,
      period: RecurringPeriod.enum.monthly,
      startDate: dateIn(start, line.day),
      account: pack.accounts.checking.name,
      category: line.category,
    },
  });

const freelanceStepsOf = (pack: DemoPack, today: string): DemoStep[] =>
  FREELANCE_MONTH_OFFSETS.map((offset) => monthContext(today, offset)).map((month) => {
    const { description, category, amount, day } = pack.freelance;
    const date = dateIn(month, day);
    const input = { description, category, amount, date, account: pack.accounts.checking.name };
    return { kind: STEP.income, date, input: { ...input, discriminator: `freelance|${month.offset}` } };
  });

const transferStepsOf = (pack: DemoPack, months: readonly MonthContext[]): DemoStep[] => {
  const transfers = [
    { to: pack.accounts.savings.name, day: SAVINGS_TRANSFER_DAY, line: pack.transfers.savings },
    { to: pack.accounts.investment.name, day: INVESTMENT_TRANSFER_DAY, line: pack.transfers.investment },
    { to: pack.accounts.wallet.name, day: WALLET_TRANSFER_DAY, line: pack.transfers.wallet },
  ];
  return R.flatMap(months, (month) =>
    transfers
      .filter(({ day }) => day <= month.lastDay)
      .map(({ to, day, line }): DemoStep => {
        const date = dateIn(month, day);
        const { description, amount } = line;
        return {
          kind: STEP.transfer,
          date,
          input: { from: pack.accounts.checking.name, to, amount, date, description },
        };
      }),
  );
};

const isCardPurchase = (step: DemoStep): step is Extract<DemoStep, { kind: typeof STEP.purchase }> =>
  step.kind === STEP.purchase;

const payAndMaybeClose =
  (card: DemoCardSpec, closesLast: boolean, periods: readonly BillPeriod[]) =>
  (period: BillPeriod, index: number): DemoStep[] => {
    const { month, year, dueDate } = period;
    const pay: DemoStep = {
      kind: STEP.payBill,
      date: dueDate,
      input: { card: card.name, month, year, paymentDate: dueDate },
    };
    const revert: DemoStep = { kind: STEP.revertBill, date: dueDate, input: { card: card.name, month, year } };
    return closesLast && index === periods.length - 1 ? [pay, revert] : [pay];
  };

/** Every bill whose due date has passed is paid; the secondary card's latest one is paid and then reverted, so it
 *  ends `closed` (a payment made from the wrong account and taken back). Bills still to come stay `open`. */
const billStepsOf = (pack: DemoPack, purchases: readonly DemoStep[], today: string): DemoStep[] => {
  const cards = [
    { card: pack.cards.primary, closesLast: false },
    { card: pack.cards.secondary, closesLast: true },
  ];
  return R.flatMap(cards, ({ card, closesLast }) => {
    const periods = R.pipe(
      purchases.filter(isCardPurchase),
      R.filter((step) => step.input.card === card.name),
      R.map((step) => billPeriodFor(step.date, card.closingDay, card.dueDay)),
      R.uniqueBy((period) => `${period.month}-${period.year}`),
      R.filter((period) => period.dueDate <= today),
      R.sortBy((period) => period.dueDate),
    );
    return R.flatMap(periods, payAndMaybeClose(card, closesLast, periods));
  });
};

const isSpend = (step: DemoStep): step is Extract<DemoStep, { kind: typeof STEP.expense | typeof STEP.purchase }> =>
  step.kind === STEP.expense || step.kind === STEP.purchase;

/** Budgets are sized against the last full month's spend: a factor under 1 is a budget that month already blew. */
const budgetStepsOf = (pack: DemoPack, spending: readonly DemoStep[], today: string, start: string): DemoStep[] => {
  const lastMonth = monthContext(today, -1);
  const prefix = `${lastMonth.year}-${pad(lastMonth.month)}-`;
  const spentByCategory = R.pipe(
    spending.filter(isSpend),
    R.filter((step) => step.date.startsWith(prefix)),
    R.groupBy((step) => step.input.category ?? ''),
    R.mapValues(R.sumBy((step) => step.input.amount)),
  );
  return R.pipe(
    pack.budgets,
    R.filter(({ category }) => (spentByCategory[category] ?? 0) > 0),
    R.map(({ category, factor }) => ({
      kind: STEP.budget,
      date: start,
      input: {
        category,
        currency: pack.currency,
        limit: roundToStep((spentByCategory[category] ?? 0) * factor, pack.amountStep),
        period: BudgetPeriod.enum.monthly,
      },
    })),
  );
};

const ratesStepsOf = (pack: DemoPack, today: string, start: string): DemoStep[] => {
  const usdc = pack.usdRate;
  const btc = pack.usdRate * DEMO_BTC_USD_PRICE;
  const quoted = [
    { from: CurrencyCode.enum.USDC, rate: usdc },
    { from: CurrencyCode.enum.BTC, rate: btc },
    ...(pack.global ? [{ from: CurrencyCode.enum.USD, rate: pack.usdRate }] : []),
  ];
  return quoted
    .filter(({ from }) => from !== pack.currency)
    .map(({ from, rate }) => ({
      kind: STEP.rate,
      date: start,
      input: { from, to: pack.currency, rate, asOf: `${today}${RATE_TIME}`, source: DEMO_RATE_SOURCE },
    }));
};

const accountStepOf =
  (start: string) =>
  (type: AccountType, currency: CurrencyCode, spec: { name: string; initialBalance: number }): DemoStep => ({
    kind: STEP.account,
    date: start,
    input: { name: spec.name, type, currency, initialBalance: spec.initialBalance },
  });

const accountStepsOf = (pack: DemoPack, start: string): DemoStep[] => {
  const account = accountStepOf(start);
  const { accounts, global, currency } = pack;
  return [
    account(AccountType.enum.checking, currency, accounts.checking),
    account(AccountType.enum.savings, currency, accounts.savings),
    account(AccountType.enum.investment, currency, accounts.investment),
    account(AccountType.enum.wallet, currency, accounts.wallet),
    account(AccountType.enum.investment, CurrencyCode.enum.USDC, accounts.usdc),
    account(AccountType.enum.investment, CurrencyCode.enum.BTC, accounts.btc),
    ...(global ? [account(AccountType.enum.checking, CurrencyCode.enum.USD, global)] : []),
  ];
};

const cardStepsOf = (pack: DemoPack, start: string): DemoStep[] =>
  [pack.cards.primary, pack.cards.secondary].map((card) => ({
    kind: STEP.card,
    date: start,
    input: {
      name: card.name,
      currency: pack.currency,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      limit: card.limit,
      paymentAccount: pack.accounts.checking.name,
    },
  }));

const recurringStepsOf = (pack: DemoPack, start: string): DemoStep[] => {
  const month = parseDate(start);
  return [
    recurringStepOf(pack, month, MovementType.enum.income)(pack.salary),
    ...[pack.rent, ...pack.subscriptions].map(recurringStepOf(pack, month, MovementType.enum.expense)),
  ];
};

const setupStepsOf = (pack: DemoPack, today: string, start: string): DemoStep[] => [
  { kind: STEP.locale, date: start, input: { locale: pack.locale, source: LocaleSource.enum.explicit } },
  { kind: STEP.baseCurrency, date: start, input: { baseCurrency: pack.currency } },
  ...accountStepsOf(pack, start),
  ...cardStepsOf(pack, start),
  ...pack.tags.map((name): DemoStep => ({ kind: STEP.tag, date: start, name })),
  ...ratesStepsOf(pack, today, start),
  ...recurringStepsOf(pack, start),
];

/**
 * The whole demo as an ordered list of writes, each to be run through the real flow of the same name with the clock
 * set to its date (`min(date, today)` — a pending item is dated ahead of today). Pure: a function of the seed, the
 * country pack and `today`. Dated steps sort stably, so the setup (dated at the window's start) leads, a bill is paid
 * after the purchases it holds (its due date follows its closing date), and recurring rules materialize last.
 */
export const planDemo = (pack: DemoPack, today: string): readonly DemoStep[] => {
  const months = windowOf(today);
  const first = months[0] ?? monthContext(today, 0);
  const start = dateIn(first, 1);
  const spending = [
    ...spendStepsOf(pack, SPEND_PREFIX.main, pack.spending, months),
    ...spendStepsOf(pack, SPEND_PREFIX.global, pack.global?.spending ?? [], months),
    ...tripStepsOf(pack, today),
  ];
  return R.sortBy(
    [
      ...setupStepsOf(pack, today, start),
      ...budgetStepsOf(pack, spending, today, start),
      ...spending,
      ...transferStepsOf(pack, months),
      ...freelanceStepsOf(pack, today),
      ...billStepsOf(pack, spending, today),
      ...pack.pending.map(pendingStepOf(pack, today)),
      { kind: STEP.applyDue, date: today, through: today },
    ],
    (step) => step.date,
  );
};

/** The clock a step runs at: its own date, except a step dated ahead of today (a pending item), which runs at today. */
export const clockDateOf = (step: DemoStep, today: string): string => (step.date > today ? today : step.date);

const REGION_COUNTRY: Readonly<Record<string, DemoCountry>> = {
  BR: DemoCountry.enum.br,
  US: DemoCountry.enum.us,
  MX: DemoCountry.enum.mx,
  CO: DemoCountry.enum.co,
};
const LANGUAGE_COUNTRY: Readonly<Record<string, DemoCountry>> = {
  [Locale.enum.pt]: DemoCountry.enum.br,
  [Locale.enum.es]: DemoCountry.enum.mx,
  [Locale.enum.en]: DemoCountry.enum.us,
};

/** The demo's default country for an OS locale tag (`es-CO`, `pt_BR.UTF-8`): its region when it is one of the four,
 *  else its language, else the default. */
export const resolveDemoCountry = (osLocale: string | undefined): DemoCountry => {
  const [language = '', region = ''] = (osLocale ?? '').replace(/[.@].*$/, '').split(/[-_]/);
  return REGION_COUNTRY[region.toUpperCase()] ?? LANGUAGE_COUNTRY[language.toLowerCase()] ?? DEFAULT_DEMO_COUNTRY;
};
