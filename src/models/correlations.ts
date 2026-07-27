import { z } from 'zod';
import { PeriodSchema } from './date.js';
import { CurrencyCode } from './money.js';

/** Analysis modes for `find_correlations` (Feature Design 016) — one mode added per PR (A:
 *  `spending_shifts`). Whitelisted enum, mirroring `aggregate_spending`'s `groupBy` (ADR-011). */
export const FindCorrelationsAnalysis = z.enum(['spending_shifts']);
export type FindCorrelationsAnalysis = z.infer<typeof FindCorrelationsAnalysis>;

// QoL defaults applied at the MCP boundary, not baked into the schema — mirrors aggregate_spending.
export const DEFAULT_BASELINE_MONTHS = 3;
export const DEFAULT_MIN_DELTA_PCT = 20;

export const FindCorrelationsSchema = z.object({
  analysis: FindCorrelationsAnalysis.describe('Which correlation analysis to run'),
  month: PeriodSchema.shape.month.describe(
    'Reference month (1-12) — spending_shifts measures this month against its trailing baseline',
  ),
  year: PeriodSchema.shape.year.describe('Reference year'),
  baselineMonths: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe(`Trailing window size in months averaged into the baseline (default ${DEFAULT_BASELINE_MONTHS})`),
  minDeltaPct: z
    .number()
    .min(0)
    .optional()
    .describe(
      `Only surface categories whose |deltaPct| is at least this percentage (default ${DEFAULT_MIN_DELTA_PCT}); ` +
        'a brand-new category with no baseline spend at all is always surfaced regardless of this threshold',
    ),
});
export type FindCorrelations = z.infer<typeof FindCorrelationsSchema>;

/** Resolved input with QoL defaults applied — mirrors `ResolvedAggregateSpending`. */
export type ResolvedFindCorrelations = FindCorrelations & {
  baselineMonths: number;
  minDeltaPct: number;
};

export const SpendingShiftDirection = z.enum(['up', 'down']);
export type SpendingShiftDirection = z.infer<typeof SpendingShiftDirection>;

export const SpendingShiftSchema = z.object({
  category: z.string().min(1).describe("Top-level category name — sub-category spend rolls up into its parent"),
  currency: CurrencyCode,
  current: z.number().describe('Effective, expense-only total for the reference month'),
  baseline: z.number().describe('Average monthly effective expense total over the preceding baselineMonths'),
  deltaPct: z
    .number()
    .nullable()
    .describe(
      '(current - baseline) / baseline, as a percentage; null when there is no baseline spend at all ' +
        '(a brand-new category), not a divide-by-zero',
    ),
  direction: SpendingShiftDirection.describe("'up' for increased or brand-new spend, 'down' for decreased spend"),
});
export type SpendingShift = z.infer<typeof SpendingShiftSchema>;

export const SpendingShiftsResultSchema = z.object({
  analysis: z.literal(FindCorrelationsAnalysis.enum.spending_shifts),
  month: PeriodSchema.shape.month,
  year: PeriodSchema.shape.year,
  shifts: z
    .array(SpendingShiftSchema)
    .describe('Sorted by |deltaPct| descending; brand-new-spend categories (deltaPct: null) sort first'),
});
export type SpendingShiftsResult = z.infer<typeof SpendingShiftsResultSchema>;

/** Additive: future phases (B recurring_candidates, C merchant_concentration, D budget_fit) each
 *  add their own result schema as a member of this union. */
export const FindCorrelationsResultSchema = z.discriminatedUnion('analysis', [SpendingShiftsResultSchema]);
export type FindCorrelationsResult = z.infer<typeof FindCorrelationsResultSchema>;
