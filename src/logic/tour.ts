import * as R from 'remeda';
import { DemoCountry } from '../models/demo.js';
import { InstanceKind } from '../models/instance.js';
import type { Locale } from '../models/locale.js';
import { CurrencyCode } from '../models/money.js';
import { TOUR_FACTS, type TourContext } from '../models/tour.js';
import { addDays, resolveDemoCountry } from './demo.js';

/** Each country pack has a currency of its own, so the base currency the seeder sets names the country. */
const CURRENCY_COUNTRY: Readonly<Partial<Record<CurrencyCode, DemoCountry>>> = {
  [CurrencyCode.enum.BRL]: DemoCountry.enum.br,
  [CurrencyCode.enum.USD]: DemoCountry.enum.us,
  [CurrencyCode.enum.MXN]: DemoCountry.enum.mx,
  [CurrencyCode.enum.COP]: DemoCountry.enum.co,
};

/** The demo's country: its base currency, else (the person switched it) the language's default country. */
export const tourCountryOf = (baseCurrency: CurrencyCode, locale: Locale): DemoCountry =>
  CURRENCY_COUNTRY[baseCurrency] ?? resolveDemoCountry(locale);

export const standardTourContext = (locale: Locale): TourContext => ({ kind: InstanceKind.enum.standard, locale });

/** The demo's tour: its language, the trip's destination and a sample statement dated just before `today`. */
export const demoTourContext = (locale: Locale, country: DemoCountry, today: string): TourContext => {
  const { destination, statement } = TOUR_FACTS[country];
  return {
    kind: InstanceKind.enum.demo,
    locale,
    destination,
    statement: R.map(statement, ({ daysAgo, description, amount, ...rest }) => ({
      date: addDays(today, -daysAgo),
      description,
      amount,
      income: 'income' in rest && rest.income === true,
    })),
  };
};
