import { StalenessClass } from '../models/timestamp.js';
import * as timestamp from './timestamp.js';

/** Hours a quote of each class has aged by: weekday hours for what only trades on weekdays, elapsed hours otherwise.
 *  Public holidays are not covered. */
const AGE_HOURS = {
  [StalenessClass.enum.fiat_rate]: timestamp.hoursExcludingWeekends,
  [StalenessClass.enum.crypto_rate]: timestamp.elapsedHours,
  [StalenessClass.enum.market_price]: timestamp.hoursExcludingWeekends,
  [StalenessClass.enum.manual_price]: timestamp.elapsedHours,
} as const satisfies Record<StalenessClass, (from: Date, to: Date) => number>;

export const isStale = (kind: StalenessClass, asOf: string, now: Date, thresholdHours: number): boolean =>
  AGE_HOURS[kind](timestamp.parse(asOf), now) > thresholdHours;
