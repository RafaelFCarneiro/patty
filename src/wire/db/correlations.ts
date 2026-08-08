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

/** One (category, currency, merchant) row — `merchant_key` is nullable (no merchant classified);
 *  `logic/correlations.ts`'s `shapeMerchantConcentration` resolves the display fallback. */
export const MerchantSpendDbRowSchema = z
  .object({
    category: z.string().min(1),
    category_names: z.string().nullable().default(null),
    currency: CurrencyCode,
    merchant_key: z.string().nullable(),
    spent: z.number(),
  })
  .transform(({ category_names, merchant_key, ...rest }) => ({
    ...rest,
    categoryNames: parseCategoryNames(category_names),
    merchantKey: merchant_key,
  }));

export type MerchantSpendDbRow = z.output<typeof MerchantSpendDbRowSchema>;

/** One qualifying transaction row for recurring-candidate detection — `merchant_key` is always
 *  non-null (the repo query filters it), unlike `MerchantSpendDbRowSchema`'s nullable one. */
export const RecurringCandidateDbRowSchema = z
  .object({
    merchant_key: z.string().min(1),
    currency: CurrencyCode,
    category: z.string().min(1),
    category_names: z.string().nullable().default(null),
    date: z.string(),
    amount: z.number(),
  })
  .transform(({ merchant_key, category_names, ...rest }) => ({
    ...rest,
    merchantKey: merchant_key,
    categoryNames: parseCategoryNames(category_names),
  }));

export type RecurringCandidateDbRow = z.output<typeof RecurringCandidateDbRowSchema>;
