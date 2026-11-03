import * as R from 'remeda';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../../../../src/diplomat/db/seed/categories.js';
import { DEMO_PACKS } from '../../../../src/diplomat/db/seed/demo/index.js';
import { billPeriodFor } from '../../../../src/logic/bill.js';
import {
  clockDateOf,
  DEMO_MONTHS_BACK,
  demoSeedStart,
  planDemo,
  resolveDemoCountry,
} from '../../../../src/logic/demo/plan.js';
import { AccountType } from '../../../../src/models/account.js';
import {
  DemoCountry,
  DemoFunding,
  DemoSeedStatus,
  DemoStepKind,
  type DemoStep,
} from '../../../../src/models/demo/core.js';
import { InstanceKind } from '../../../../src/models/instance.js';
import { Locale } from '../../../../src/models/locale.js';
import { CurrencyCode } from '../../../../src/models/money.js';

const TODAY = '2026-10-26';
const RATES_AS_OF = '2026-10-26T18:42:07.000Z';
const WINDOW_START = '2026-06-01';
const COUNTRIES = Object.values(DemoCountry.enum);
const K = DemoStepKind.enum;

const CURRENCY_OF = {
  [DemoCountry.enum.br]: CurrencyCode.enum.BRL,
  [DemoCountry.enum.us]: CurrencyCode.enum.USD,
  [DemoCountry.enum.mx]: CurrencyCode.enum.MXN,
  [DemoCountry.enum.co]: CurrencyCode.enum.COP,
} as const;
const LOCALE_OF = {
  [DemoCountry.enum.br]: Locale.enum.pt,
  [DemoCountry.enum.us]: Locale.enum.en,
  [DemoCountry.enum.mx]: Locale.enum.es,
  [DemoCountry.enum.co]: Locale.enum.es,
} as const;

const planFor = (country: DemoCountry, today = TODAY): readonly DemoStep[] =>
  planDemo(DEMO_PACKS[country], today, RATES_AS_OF);
const ofKind = <Kind extends DemoStepKind>(plan: readonly DemoStep[], kind: Kind) =>
  plan.filter((step): step is Extract<DemoStep, { kind: Kind }> => step.kind === kind);

describe('planDemo — determinism', () => {
  it.each(COUNTRIES)('is a pure function of the seed, the pack and today (%s)', (country) => {
    expect(planFor(country)).toEqual(planFor(country));
  });

  it('changes with the country and with today', () => {
    expect(planFor(DemoCountry.enum.us)).not.toEqual(planFor(DemoCountry.enum.br));
    expect(planFor(DemoCountry.enum.us)).not.toEqual(planFor(DemoCountry.enum.us, '2026-11-12'));
  });
});

describe('planDemo — budgets in the pack’s currency', () => {
  it('Brazil sizes the shopping budget without the Conta Global’s dollar purchases', () => {
    const plan = planFor(DemoCountry.enum.br);
    const global = DEMO_PACKS[DemoCountry.enum.br].global!.name;
    const shopping = (include: boolean) =>
      [...ofKind(plan, K.purchase), ...ofKind(plan, K.expense)]
        .filter((step) => step.input.category === 'Shopping' && step.date.startsWith('2026-09'))
        .filter((step) => include || !('account' in step.input && step.input.account === global))
        .reduce((total, step) => total + step.input.amount, 0);
    const limit = ofKind(plan, K.budget).find((step) => step.input.category === 'Shopping')!.input.limit;
    expect(shopping(true)).toBeGreaterThan(shopping(false));
    expect(limit).toBeCloseTo(shopping(false) * 1.35, 1);
  });
});

describe('planDemo — exchange rates', () => {
  it('are observed at the instant given, not at a fixed hour of the day', () => {
    const rates = ofKind(planFor(DemoCountry.enum.br), K.rate);
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((step) => step.input.asOf === RATES_AS_OF)).toBe(true);
  });
});

describe.each(COUNTRIES)('planDemo — coverage (%s)', (country) => {
  const pack = DEMO_PACKS[country];
  const plan = planFor(country);

  it('exercises every kind of write', () => {
    const kinds = new Set(plan.map((step) => step.kind));
    expect([...kinds].sort()).toEqual(Object.values(K).sort());
  });

  it('opens checking, savings, investment and wallet accounts, plus a USDC and a BTC position', () => {
    const accounts = ofKind(plan, K.account).map((step) => step.input);
    const types = R.unique(accounts.map((account) => account.type));
    expect(types).toEqual(expect.arrayContaining([AccountType.enum.checking, AccountType.enum.savings]));
    expect(types).toEqual(expect.arrayContaining([AccountType.enum.investment, AccountType.enum.wallet]));
    const currencies = accounts.map((account) => account.currency);
    expect(currencies).toEqual(expect.arrayContaining([CurrencyCode.enum.USDC, CurrencyCode.enum.BTC]));
  });

  it('has two cards, recurring salary/rent/subscriptions, budgets, tags and exchange rates', () => {
    expect(ofKind(plan, K.card)).toHaveLength(2);
    expect(ofKind(plan, K.recurring)).toHaveLength(2 + pack.subscriptions.length);
    expect(ofKind(plan, K.budget).length).toBeGreaterThanOrEqual(4);
    expect(ofKind(plan, K.tag).map((step) => step.name)).toEqual(pack.tags);
    expect(ofKind(plan, K.rate).length).toBeGreaterThanOrEqual(2);
  });

  it('has income, transfers between accounts and pending items dated after today', () => {
    expect(ofKind(plan, K.income).length).toBeGreaterThan(0);
    expect(ofKind(plan, K.transfer).length).toBeGreaterThanOrEqual(3 * DEMO_MONTHS_BACK);
    const pending = plan.filter((step) => step.date > TODAY);
    expect(pending).toHaveLength(pack.pending.length);
  });

  it('keeps every date inside the last four full months plus the current one', () => {
    const past = plan.filter((step) => step.date <= TODAY);
    expect(past.every((step) => step.date >= WINDOW_START)).toBe(true);
    expect(plan.every((step) => step.date >= WINDOW_START)).toBe(true);
  });

  it('is ordered by date, with the setup first and the recurring rules materialized last (today)', () => {
    expect(plan.map((step) => step.date)).toEqual([...plan.map((step) => step.date)].sort());
    expect(plan[0]?.kind).toBe(K.locale);
    const [applyDue] = ofKind(plan, K.applyDue);
    expect(applyDue?.through).toBe(TODAY);
    expect(plan.filter((step) => step.date === TODAY).at(-1)?.kind).toBe(K.applyDue);
  });

  it('pays each bill after the purchases it holds, and reverts only the secondary card’s latest', () => {
    const cards = [pack.cards.primary, pack.cards.secondary];
    const purchases = ofKind(plan, K.purchase);
    const payments = ofKind(plan, K.payBill);
    payments.forEach((payment) => {
      const card = cards.find((candidate) => candidate.name === payment.input.card)!;
      const held = purchases.filter(
        (purchase) =>
          purchase.input.card === card.name &&
          billPeriodFor(purchase.date, card.closingDay, card.dueDay).month === payment.input.month &&
          billPeriodFor(purchase.date, card.closingDay, card.dueDay).year === payment.input.year,
      );
      expect(held.length).toBeGreaterThan(0);
      expect(held.every((purchase) => purchase.date < payment.date)).toBe(true);
      expect(payment.date <= TODAY).toBe(true);
    });
    const reverted = ofKind(plan, K.revertBill);
    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.input.card).toBe(pack.cards.secondary.name);
  });

  it('leaves each card with a bill still open (a purchase whose bill is not yet due)', () => {
    [pack.cards.primary, pack.cards.secondary].forEach((card) => {
      const open = ofKind(plan, K.purchase).filter(
        (purchase) =>
          purchase.input.card === card.name &&
          billPeriodFor(purchase.date, card.closingDay, card.dueDay).dueDate > TODAY,
      );
      expect(open.length).toBeGreaterThan(0);
    });
  });

  it('never repeats a discriminator, so two look-alike purchases stay two rows', () => {
    const keys = plan.flatMap((step) =>
      'input' in step && 'discriminator' in step.input && step.input.discriminator ? [step.input.discriminator] : [],
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sizes budgets from last month’s spend: some blown (limit below it), some comfortable', () => {
    const lastMonth = ofKind(plan, K.purchase)
      .map((step) => ({ category: step.input.category, amount: step.input.amount, date: step.date }))
      .concat(
        ofKind(plan, K.expense).map((step) => ({
          category: step.input.category,
          amount: step.input.amount,
          date: step.date,
        })),
      )
      .filter(({ date }) => date.startsWith('2026-09'));
    const spent = R.mapValues(
      R.groupBy(lastMonth, ({ category }) => category ?? ''),
      R.sumBy(({ amount }) => amount),
    );
    const budgets = ofKind(plan, K.budget).map((step) => step.input);
    expect(budgets.some((budget) => budget.limit < (spent[budget.category ?? ''] ?? 0))).toBe(true);
    expect(budgets.some((budget) => budget.limit > (spent[budget.category ?? ''] ?? 0))).toBe(true);
  });
});

describe.each(COUNTRIES)('planDemo — the trip (%s)', (country) => {
  const pack = DEMO_PACKS[country];
  const plan = planFor(country);
  const trip = [...ofKind(plan, K.purchase), ...ofKind(plan, K.expense)].filter((step) =>
    step.input.description.includes(pack.trip.destination),
  );

  it('is untagged, spans several categories and funding sources, over about six days', () => {
    expect(trip).toHaveLength(pack.trip.items.length);
    expect(trip.every((step) => !('tags' in step.input))).toBe(true);
    expect(R.unique(trip.map((step) => step.input.category)).length).toBeGreaterThanOrEqual(4);
    const sources = R.unique(trip.map((step) => ('card' in step.input ? step.input.card : step.input.account)));
    expect(sources.length).toBeGreaterThanOrEqual(2);
    const dates = trip.map((step) => step.date).sort();
    expect(dates.length).toBeGreaterThan(1);
    const days = (new Date(dates.at(-1)!).getTime() - new Date(dates[0]!).getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(5);
  });

  it('falls inside the window and is already behind today', () => {
    expect(trip.every((step) => step.date >= WINDOW_START && step.date <= TODAY)).toBe(true);
  });
});

describe('country packs', () => {
  const seededNames = new Set<string>(CATEGORIES.map((category) => category.name));

  it.each(COUNTRIES)('%s uses its own currency and language', (country) => {
    const pack = DEMO_PACKS[country];
    expect(pack.country).toBe(country);
    expect(pack.currency).toBe(CURRENCY_OF[country]);
    expect(pack.locale).toBe(LOCALE_OF[country]);
    const plan = planFor(country);
    expect(ofKind(plan, K.locale)[0]?.input.locale).toBe(LOCALE_OF[country]);
    expect(ofKind(plan, K.baseCurrency)[0]?.input.baseCurrency).toBe(CURRENCY_OF[country]);
    const fiat = ofKind(plan, K.card).map((step) => step.input.currency);
    expect(new Set(fiat)).toEqual(new Set([CURRENCY_OF[country]]));
  });

  it.each(COUNTRIES)('%s has every key the generator asks for', (country) => {
    const pack = DEMO_PACKS[country];
    const lines = [...pack.spending, ...(pack.global?.spending ?? [])];
    const categories = [
      ...lines.map((line) => line.category),
      ...pack.pending.map((line) => line.category),
      ...pack.trip.items.map((item) => item.category),
      ...[pack.salary, pack.rent, pack.freelance, ...pack.subscriptions].map((line) => line.category),
      ...pack.budgets.map((budget) => budget.category),
    ];
    expect(categories.every((category) => seededNames.has(category))).toBe(true);
    expect(lines.flatMap((line) => (line.tag ? [line.tag] : [])).every((tag) => pack.tags.includes(tag))).toBe(true);
    const usesGlobal = [...pack.spending, ...pack.pending, ...pack.trip.items].some(
      (line) => line.via === DemoFunding.enum.global,
    );
    expect(usesGlobal).toBe(false);
    expect(lines.every((line) => line.min <= line.max && line.perMonth > 0)).toBe(true);
    expect(pack.cards.primary.name).not.toBe(pack.cards.secondary.name);
  });

  it.each(COUNTRIES)('%s only has a dollar account when the pack lists its purchases', (country) => {
    const pack = DEMO_PACKS[country];
    const plan = planFor(country);
    const dollar = ofKind(plan, K.account).filter(
      (step) => step.input.currency === CurrencyCode.enum.USD && pack.currency !== CurrencyCode.enum.USD,
    );
    expect(dollar).toHaveLength(pack.global ? 1 : 0);
    expect(ofKind(plan, K.rate).map((step) => step.input.to)).toEqual(ofKind(plan, K.rate).map(() => pack.currency));
  });

  it('gives Brazil a USD Conta Global with dollar purchases, and nobody else', () => {
    expect(DEMO_PACKS[DemoCountry.enum.br].global?.name).toBe('Nubank Conta Global');
    expect(
      ofKind(planFor(DemoCountry.enum.br), K.expense).filter((step) => step.input.account === 'Nubank Conta Global')
        .length,
    ).toBeGreaterThanOrEqual(4);
    [DemoCountry.enum.us, DemoCountry.enum.mx, DemoCountry.enum.co].forEach((country) => {
      expect(DEMO_PACKS[country].global).toBeUndefined();
    });
  });

  it('shapes amounts to the currency: COP in whole hundreds, the rest to the cent', () => {
    const amounts = (country: DemoCountry) => ofKind(planFor(country), K.purchase).map((step) => step.input.amount);
    expect(amounts(DemoCountry.enum.co).every((amount) => amount % 100 === 0)).toBe(true);
    expect(Math.min(...amounts(DemoCountry.enum.co))).toBeGreaterThan(1000);
    expect(
      amounts(DemoCountry.enum.us).every((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6),
    ).toBe(true);
  });
});

describe('clockDateOf', () => {
  const at = (date: string): DemoStep => ({ kind: K.tag, date, name: 'x' });

  it('runs a step at its own date', () => {
    expect(clockDateOf(at('2026-08-14'), TODAY)).toBe('2026-08-14');
  });

  it('runs a step dated ahead of today at today', () => {
    expect(clockDateOf(at('2026-10-30'), TODAY)).toBe(TODAY);
  });
});

describe('resolveDemoCountry — the OS locale picks the demo', () => {
  it.each([
    ['es-CO', 'co'],
    ['es-Latn-CO', 'co'],
    ['en-u-co-phonebk', 'us'],
    ['es-u-co-trad', 'mx'],
    ['es-CO-u-ca-gregory', 'co'],
    ['pt-Latn-BR', 'br'],
    ['es-Latn', 'mx'],
    ['es_CO.UTF-8', 'co'],
    ['es-MX', 'mx'],
    ['es', 'mx'],
    ['es-ES', 'mx'],
    ['pt', 'br'],
    ['pt-PT', 'br'],
    ['pt_BR.UTF-8', 'br'],
    ['en-US', 'us'],
    ['en-GB', 'us'],
    ['en', 'us'],
    ['fr-FR', 'us'],
    ['de', 'us'],
    ['en-CO', 'co'],
    ['', 'us'],
    [undefined, 'us'],
  ])('%s → %s', (osLocale, expected) => {
    expect(resolveDemoCountry(osLocale)).toBe(expected);
  });
});

describe('demoSeedStart', () => {
  const SEEDED_AT = '2026-10-26T12:00:00.000Z';
  const { standard, demo } = InstanceKind.enum;

  it.each([
    ['an empty standard database', { hasUserData: false, kind: standard, seededAt: null }, 'fresh'],
    ['a demo marked before any data landed', { hasUserData: false, kind: demo, seededAt: null }, 'fresh'],
    ['a seeded demo', { hasUserData: true, kind: demo, seededAt: SEEDED_AT }, DemoSeedStatus.enum.present],
    [
      'a demo whose seed never finished',
      { hasUserData: true, kind: demo, seededAt: null },
      DemoSeedStatus.enum.interrupted,
    ],
    [
      'a standard database holding data',
      { hasUserData: true, kind: standard, seededAt: null },
      DemoSeedStatus.enum.not_demo,
    ],
    [
      'a standard database holding data and a stray marker',
      { hasUserData: true, kind: standard, seededAt: SEEDED_AT },
      DemoSeedStatus.enum.not_demo,
    ],
  ])('%s → %s', (_label, facts, expected) => {
    expect(demoSeedStart(facts)).toBe(expected);
  });
});
