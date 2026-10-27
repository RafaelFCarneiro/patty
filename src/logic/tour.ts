import * as R from 'remeda';
import type { DemoCountry } from '../models/demo.js';
import { InstanceKind } from '../models/instance.js';
import type { Locale } from '../models/locale.js';
import { TOUR_FACTS, type TourContext } from '../models/tour.js';
import { resolveDemoCountry } from './demo.js';
import { addDays } from './period.js';

/** The demo's country: the one the seeder recorded, else (a demo seeded before that) the language's default. */
export const tourCountryOf = (recorded: DemoCountry | null, locale: Locale): DemoCountry =>
  recorded ?? resolveDemoCountry(locale);

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
