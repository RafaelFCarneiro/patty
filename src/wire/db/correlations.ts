import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import { parseCategoryNames } from './categories.js';

/** `current`/`baseline_total` are raw SUMs — `logic/correlations.ts`'s `toSpendingShift` divides
 *  `baselineTotal` by `baselineMonths` and derives `deltaPct`/`direction` from the pair. */
export const SpendingShiftDbRowSchema = z
  .object({
    category: z.string().min(1),
    category_names: z.string().nullable().default(null),
    currency: CurrencyCode,
    current: z.number(),
    baseline_total: z.number(),
  })
  .transform(({ category_names, baseline_total, ...rest }) => ({
    ...rest,
    categoryNames: parseCategoryNames(category_names),
    baselineTotal: baseline_total,
  }));

export type SpendingShiftDbRow = z.output<typeof SpendingShiftDbRowSchema>;
