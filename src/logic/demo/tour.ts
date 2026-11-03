import * as R from 'remeda';
import { DemoCountry } from '../../models/demo/demo.js';
import { InstanceKind } from '../../models/instance.js';
import type { Locale } from '../../models/locale.js';
import { CurrencyCode } from '../../models/money.js';
import { TOUR_FACTS, type TourContext } from '../../models/demo/tour.js';
import { resolveDemoCountry } from './plan.js';
import { addDays } from '../period.js';

/** Each country pack has a currency of its own, so the base currency the seeder set names the country. */
const CURRENCY_COUNTRY: Readonly<Partial<Record<CurrencyCode, DemoCountry>>> = {
  [CurrencyCode.enum.BRL]: DemoCountry.enum.br,
  [CurrencyCode.enum.USD]: DemoCountry.enum.us,
  [CurrencyCode.enum.MXN]: DemoCountry.enum.mx,
  [CurrencyCode.enum.COP]: DemoCountry.enum.co,
};

/** The demo's country: the one the seeder recorded. A demo seeded before that was recorded is resolved from the
 *  base currency its seed stored (Spanish alone cannot tell Mexico from Colombia), then from the language. */
export const tourCountryOf = (
  recorded: DemoCountry | null,
  baseCurrency: CurrencyCode | null,
  locale: Locale,
): DemoCountry => recorded ?? (baseCurrency && CURRENCY_COUNTRY[baseCurrency]) ?? resolveDemoCountry(locale);

export const standardTourContext = (locale: Locale): TourContext => ({ kind: InstanceKind.enum.standard, locale });

/** The demo's tour: its language, the trip's destination and a sample statement dated just before `today`. */
export const demoTourContext = (locale: Locale, country: DemoCountry, today: string): TourContext => {
  const { destination, statement } = TOUR_FACTS[country];
  return {
    kind: InstanceKind.enum.demo,
    locale,
    destination,
    statement: R.map(statement, (line) => ({
      date: addDays(today, -line.daysAgo),
      description: line.description,
      amount: line.amount,
      income: line.income ?? false,
    })),
  };
};
