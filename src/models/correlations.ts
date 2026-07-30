import { z } from 'zod';
import { IsoDate, PeriodSchema } from './date.js';
import type { ValidationError } from './error.js';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';

/** Analysis modes for `find_correlations` (Feature Design 016) — one mode added per PR (A:
 *  `spending_shifts`, D: `budget_fit`, C: `merchant_concentration`, B: `recurring_candidates`).
 *  Whitelisted enum, mirroring `aggregate_spending`'s `groupBy` (ADR-011). */
export const FindCorrelationsAnalysis = z.enum([
  'spending_shifts',
  'budget_fit',
  'merchant_concentration',
  'recurring_candidates',
]);
export type FindCorrelationsAnalysis = z.infer<typeof FindCorrelationsAnalysis>;

// QoL defaults applied at the MCP boundary, not baked into the schema — mirrors aggregate_spending.
export const DEFAULT_BASELINE_MONTHS = 3;
export const DEFAULT_MIN_DELTA_PCT = 20;
export const DEFAULT_SLACK_PCT = 20;
export const DEFAULT_OVER_PCT = 20;
export const DEFAULT_TOP_N = 5;
export const DEFAULT_LOOKBACK_MONTHS = 6;
export const DEFAULT_MIN_OCCURRENCES = 3;

// A small cushion above the trailing average for `suggestedLimit` (budget_fit) — a limit set
// exactly at the average would be exceeded by any normal month-to-month variance.
export const SUGGESTED_LIMIT_MARGIN_PCT = 10;

// Fixed tolerance constants for `detectRecurringCadence` — not caller-adjustable like
// `lookbackMonths`/`minOccurrences`. A real month is 28-31 days; ±5 around a 30-day nominal gap
// covers every calendar month length without also accepting a weekly or quarterly pattern.
export const CADENCE_NOMINAL_GAP_DAYS = 30;
export const CADENCE_DAY_TOLERANCE_DAYS = 5;
export const CADENCE_AMOUNT_TOLERANCE_PCT = 10;

// Shared between minDeltaPct's own field description below and the tool's registered description
// (diplomat/mcp/server.ts), so the two can't drift apart.
export const NEW_CATEGORY_ALWAYS_SURFACED_NOTE =
  'a brand-new category with no baseline spend at all is always surfaced regardless of this threshold';

export const FindCorrelationsSchema = z.object({
  analysis: FindCorrelationsAnalysis.describe('Which correlation analysis to run'),
  // Requiredness is enforced per-mode in controllers/correlations.ts via `hasPeriod`, not here —
  // mirrors aggregate_spending's own from/to-or-period flexibility.
  month: PeriodSchema.shape.month
    .optional()
    .describe(
      'Reference month (1-12) — spending_shifts/budget_fit/merchant_concentration measure this month against ' +
        'its trailing baseline; not used by recurring_candidates',
    ),
  year: PeriodSchema.shape.year.optional().describe('Reference year — not used by recurring_candidates'),
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
        NEW_CATEGORY_ALWAYS_SURFACED_NOTE,
    ),
  slackPct: z
    .number()
    .min(0)
    .optional()
    .describe(
      `budget_fit: how far below the limit the baseline can sit before the budget is "generous" — ` +
        `percentage (default ${DEFAULT_SLACK_PCT})`,
    ),
  overPct: z
    .number()
    .min(0)
    .optional()
    .describe(
      `budget_fit: how far above the limit the baseline can sit before the budget is "unrealistic" — ` +
        `percentage (default ${DEFAULT_OVER_PCT})`,
    ),
  category: z
    .string()
    .min(1)
    .optional()
    .describe('merchant_concentration: restrict to a single category by name (default: every category)'),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(`merchant_concentration: top merchants to return per category (default ${DEFAULT_TOP_N})`),
  lookbackMonths: z
    .number()
    .int()
    .min(1)
    .max(36)
    .optional()
    .describe(
      `recurring_candidates: months of transaction history to scan for a recurring pattern, ending today ` +
        `(default ${DEFAULT_LOOKBACK_MONTHS})`,
    ),
  minOccurrences: z
    .number()
    .int()
    .min(2)
    .max(24)
    .optional()
    .describe(
      `recurring_candidates: minimum qualifying occurrences within the lookback window to flag a candidate ` +
        `(default ${DEFAULT_MIN_OCCURRENCES})`,
    ),
});
export type FindCorrelations = z.infer<typeof FindCorrelationsSchema>;

/** Resolved input with QoL defaults applied — mirrors `ResolvedAggregateSpending`. */
export type ResolvedFindCorrelations = FindCorrelations & {
  baselineMonths: number;
  minDeltaPct: number;
  slackPct: number;
  overPct: number;
  topN: number;
  lookbackMonths: number;
  minOccurrences: number;
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

/** What `logic/correlations.ts`'s `shapeSpendingShifts` needs per row — structurally matches
 *  `SpendingShiftDbRow` (`wire/db/correlations.ts`), so the repo's already-decoded rows satisfy it
 *  with no explicit conversion, while `logic/` itself depends on `models/` only, never `wire/db`. */
export type SpendingShiftInput = {
  category: string;
  categoryNames: Record<string, string> | null;
  currency: CurrencyCode;
  current: number;
  baselineTotal: number;
};

export const SpendingShiftsResultSchema = z.object({
  analysis: z.literal(FindCorrelationsAnalysis.enum.spending_shifts),
  month: PeriodSchema.shape.month,
  year: PeriodSchema.shape.year,
  shifts: z
    .array(SpendingShiftSchema)
    .describe('Sorted by |deltaPct| descending; brand-new-spend categories (deltaPct: null) sort first'),
});
export type SpendingShiftsResult = z.infer<typeof SpendingShiftsResultSchema>;

/** `realistic`/`generous` are unambiguous; the design doc left the over-budget bucket's name
 *  undecided ("tight/unrealistic") — `unrealistic` chosen as the more informative of the two, one
 *  verdict, not two. */
export const BudgetFitVerdict = z.enum(['realistic', 'unrealistic', 'generous']);
export type BudgetFitVerdict = z.infer<typeof BudgetFitVerdict>;

export const BudgetFitLineSchema = z.object({
  id: Id.describe('Budget id (from create_budget/list_budgets) — pass to update_budget to apply suggestedLimit'),
  category: z.string().min(1).describe("Top-level category name — the sub-category's parent, when set"),
  subCategory: z
    .string()
    .min(1)
    .optional()
    .describe('Sub-category name, present only when this budget targets a sub-category rather than its parent'),
  currency: CurrencyCode,
  limit: z.number().describe("This budget's current limit"),
  current: z.number().describe('Effective, expense-only total for the reference month'),
  baseline: z.number().describe('Average monthly effective expense total over the preceding baselineMonths'),
  verdict: BudgetFitVerdict.describe(
    'realistic: baseline within tolerance of limit. unrealistic: baseline materially over limit — ' +
      'consistently over-budget. generous: baseline well under limit.',
  ),
  suggestedLimit: z.number().describe('A more realistic limit given actual spend: baseline plus a small margin'),
});
export type BudgetFitLine = z.infer<typeof BudgetFitLineSchema>;

/** What `logic/correlations.ts`'s `shapeBudgetFitLines` needs per row — same rationale as
 *  `SpendingShiftInput` above; structurally matches `BudgetFitDbRow` (`wire/db/correlations.ts`). */
export type BudgetFitInput = {
  id: string;
  currency: CurrencyCode;
  limit: number;
  nodeName: string;
  nodeNames: Record<string, string> | null;
  nodeParentId: string | null;
  parentName: string | null;
  parentNames: Record<string, string> | null;
  current: number;
  baselineTotal: number;
};

export const UnbudgetedSpendSchema = z.object({
  category: z.string().min(1).describe('Top-level category name with material spend but no budget at all'),
  currency: CurrencyCode,
  baseline: z.number().describe('Average monthly effective expense total over the preceding baselineMonths'),
  suggestedLimit: z.number().describe('A starting limit given actual spend: baseline plus a small margin'),
});
export type UnbudgetedSpend = z.infer<typeof UnbudgetedSpendSchema>;

export const BudgetFitResultSchema = z.object({
  analysis: z.literal(FindCorrelationsAnalysis.enum.budget_fit),
  month: PeriodSchema.shape.month,
  year: PeriodSchema.shape.year,
  budgeted: z
    .array(BudgetFitLineSchema)
    .describe('Every existing budget, with a verdict on whether its limit matches actual spend'),
  unbudgeted: z
    .array(UnbudgetedSpendSchema)
    .describe('Categories with an established (nonzero baseline) spend pattern but no budget at all'),
});
export type BudgetFitResult = z.infer<typeof BudgetFitResultSchema>;

/** What `logic/correlations.ts`'s `shapeMerchantConcentration` needs per row — same rationale as
 *  `SpendingShiftInput` above; structurally matches `MerchantSpendDbRow` (`wire/db/correlations.ts`). */
export type MerchantConcentrationInput = {
  category: string;
  categoryNames: Record<string, string> | null;
  currency: CurrencyCode;
  merchantKey: string | null;
  spent: number;
};

export const MerchantShareSchema = z.object({
  merchant: z.string().min(1).describe('Merchant key, or a localized "Unknown" when the transaction has none'),
  spent: z.number().describe('Effective expense total for this merchant within the category'),
  share: z.number().describe('spent / categoryTotal, as a 0-1 fraction'),
  cumulativeShare: z.number().describe('Running total of share, in descending-spend order, through this merchant'),
});
export type MerchantShare = z.infer<typeof MerchantShareSchema>;

export const CategoryConcentrationSchema = z.object({
  category: z.string().min(1).describe("Top-level category name — sub-category spend rolls up into its parent"),
  currency: CurrencyCode,
  categoryTotal: z.number().describe('Total effective expense in this category for the period'),
  merchants: z.array(MerchantShareSchema).describe('Top `topN` merchants by spend, descending'),
  othersSpent: z.number().describe('categoryTotal minus the sum of the returned merchants — the long tail'),
});
export type CategoryConcentration = z.infer<typeof CategoryConcentrationSchema>;

export const MerchantConcentrationResultSchema = z.object({
  analysis: z.literal(FindCorrelationsAnalysis.enum.merchant_concentration),
  month: PeriodSchema.shape.month,
  year: PeriodSchema.shape.year,
  categories: z
    .array(CategoryConcentrationSchema)
    .describe('One entry per (category, currency) with spend in the period; sorted by category name'),
});
export type MerchantConcentrationResult = z.infer<typeof MerchantConcentrationResultSchema>;

/** What `logic/correlations.ts`'s `shapeRecurringCandidates` needs per row — same rationale as
 *  `SpendingShiftInput` above; structurally matches `RecurringCandidateDbRow` (`wire/db/correlations.ts`).
 *  One row per qualifying transaction (not pre-grouped) — grouping by `(merchantKey, currency)` and
 *  cadence detection both happen in `logic/`. */
export type RecurringCandidateInput = {
  merchantKey: string;
  currency: CurrencyCode;
  category: string;
  categoryNames: Record<string, string> | null;
  date: IsoDate;
  amount: number;
};

export const RecurringCandidateSchema = z.object({
  merchant: z.string().min(1).describe('Normalized merchant key — pass as `merchant` to create_recurring'),
  typicalAmount: z.number().describe('Average amount across the qualifying occurrences'),
  currency: CurrencyCode,
  category: z.string().min(1).describe("Category of the merchant's most recent occurrence"),
  occurrences: z.number().int().describe('Number of qualifying transactions within the lookback window'),
  lastDate: IsoDate.describe('Date of the most recent occurrence'),
  suggestedNextDue: IsoDate.describe("lastDate advanced one cadence — ready for create_recurring's startDate"),
});
export type RecurringCandidate = z.infer<typeof RecurringCandidateSchema>;

export const RecurringCandidatesResultSchema = z.object({
  analysis: z.literal(FindCorrelationsAnalysis.enum.recurring_candidates),
  candidates: z
    .array(RecurringCandidateSchema)
    .describe('Sorted by occurrences descending, then merchant; excludes merchants already backing a rule'),
});
export type RecurringCandidatesResult = z.infer<typeof RecurringCandidatesResultSchema>;

export const FindCorrelationsResultSchema = z.discriminatedUnion('analysis', [
  SpendingShiftsResultSchema,
  BudgetFitResultSchema,
  MerchantConcentrationResultSchema,
  RecurringCandidatesResultSchema,
]);
export type FindCorrelationsResult = z.infer<typeof FindCorrelationsResultSchema>;

export type FindCorrelationsError = ValidationError;

export const findCorrelationsErrors = {
  unhandledAnalysis: (analysis: string): FindCorrelationsError => ({
    code: 'validation',
    issues: [`Unhandled analysis "${analysis}"`],
  }),
  missingPeriod: (analysis: string): FindCorrelationsError => ({
    code: 'validation',
    issues: [`analysis "${analysis}" requires month and year`],
  }),
};
