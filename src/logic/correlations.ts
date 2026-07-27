import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { roundMoney } from './money.js';
import { SpendingShiftDirection, type SpendingShift } from '../models/correlations.js';
import type { Locale } from '../models/locale.js';
import type { SpendingShiftDbRow } from '../wire/db/correlations.js';

/** A shift with no measurable baseline (brand-new spend) has no percentage to compare against
 *  `minDeltaPct`, but is always the most notable kind of shift — sorts as maximally significant. */
const shiftMagnitude = (deltaPct: number | null): number =>
  deltaPct === null ? Number.POSITIVE_INFINITY : Math.abs(deltaPct);

const passesThreshold = (deltaPct: number | null, minDeltaPct: number): boolean =>
  deltaPct === null || Math.abs(deltaPct) >= minDeltaPct;

const toSpendingShift = (row: SpendingShiftDbRow, baselineMonths: number, locale: Locale): SpendingShift => {
  // Decide null/direction/deltaPct off the unrounded baseline — rounding first could turn a real
  // (if tiny) baseline into a false 0.00, misclassifying it as brand-new.
  const rawBaseline = row.baselineTotal / baselineMonths;
  const deltaPct = rawBaseline === 0 ? null : roundMoney(((row.current - rawBaseline) / rawBaseline) * 100);
  const direction =
    deltaPct === null || row.current >= rawBaseline
      ? SpendingShiftDirection.enum.up
      : SpendingShiftDirection.enum.down;
  return {
    category: localizeCategoryName(row.category, row.categoryNames, locale) ?? row.category,
    currency: row.currency,
    current: roundMoney(row.current),
    baseline: roundMoney(rawBaseline),
    deltaPct,
    direction,
  };
};

export const shapeSpendingShifts = (
  rows: readonly SpendingShiftDbRow[],
  baselineMonths: number,
  minDeltaPct: number,
  locale: Locale,
): SpendingShift[] =>
  R.pipe(
    rows,
    R.map((row) => toSpendingShift(row, baselineMonths, locale)),
    R.filter((shift) => passesThreshold(shift.deltaPct, minDeltaPct)),
    R.sortBy([(shift) => shiftMagnitude(shift.deltaPct), 'desc']),
  );
