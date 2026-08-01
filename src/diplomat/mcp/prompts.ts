import { z } from 'zod';
import type { Period } from '../../models/date.js';
import { PeriodSchema } from '../../models/date.js';
import { ImportStatementSource } from '../../models/prompts.js';

/** Guided-workflow MCP prompts (Feature Design 019) — orchestration text only, no DB access, no
 *  controller. The *model* executes the tools the text instructs it to call. `diplomat/*` may not
 *  depend on `logic/` (`docs/architecture.md` § Dependency direction), so the trivial date
 *  formatting below stays local rather than reusing `logic/period.ts`'s private `pad`. */
const pad = (n: number): string => String(n).padStart(2, '0');

/** Shared by monthly_review/budget_checkup: both are scoped to one calendar month. The MCP prompt
 *  protocol always sends string arguments (GetPromptRequest.arguments is Record<string, string>),
 *  so each field coerces to a number before validating through PeriodSchema's own bounds — reusing
 *  them rather than restating "1-12"/"2000-2100" as a second pair of literals. */
export const PeriodPromptArgsSchema = {
  month: z.coerce
    .number()
    .pipe(PeriodSchema.shape.month)
    .optional()
    .describe('Month (1-12) — default: the current month'),
  year: z.coerce
    .number()
    .pipe(PeriodSchema.shape.year)
    .optional()
    .describe('Calendar year — default: the current year'),
};

export const ImportStatementPromptArgsSchema = {
  source: ImportStatementSource.optional().describe(
    '"card" or "account" — omit to ask the user which kind of statement they have',
  ),
};

/** Resolves the effective review period: an omitted month or year falls back to `now`'s, so
 *  passing only one of the two (e.g. just a past year) still anchors the other to today. */
export const resolvePromptPeriod = (args: { month?: number; year?: number }, now: Date): Period => ({
  month: args.month ?? now.getMonth() + 1,
  year: args.year ?? now.getFullYear(),
});

const formatPeriod = ({ month, year }: Period): string => `${pad(month)}/${year}`;

const CURRENCY_RULE =
  'Group every figure by currency and never sum across currencies — BRL and USD are always reported separately.';

export const monthlyReviewPromptText = (period: Period): string =>
  `You are reviewing the user's finances for ${formatPeriod(period)}. Call get_spending_summary, ` +
  `find_correlations with analysis "spending_shifts", then "budget_fit", then "recurring_candidates" ` +
  `(all scoped to month ${period.month} year ${period.year}), and get_budget_status for the same period. ` +
  'Then write a brief, prose review — no raw table dumps: per-currency income/expenses/balance; the 2-3 ' +
  'biggest category shifts vs the baseline and a plausible driver for each; which budgets are over or have ' +
  `slack; and any recurring-payment candidates worth turning into a rule via create_recurring. ${CURRENCY_RULE}`;

export const budgetCheckupPromptText = (period: Period): string =>
  `You are checking the user's budgets for ${formatPeriod(period)}. Call get_budget_status and ` +
  `find_correlations with analysis "budget_fit" (both scoped to month ${period.month} year ${period.year}). ` +
  'Report which budgets are on track, over, or generous; surface each suggestedLimit; and flag any ' +
  'unbudgeted category with a significant, established spend pattern. Offer to apply a suggestion — with ' +
  "the user's say-so, call update_budget (existing budget) or create_budget (unbudgeted category) with the " +
  `suggested limit. ${CURRENCY_RULE}`;

const describeStatementSource = (source: ImportStatementSource | undefined): string => {
  if (source === ImportStatementSource.enum.card) {
    return 'The statement is a credit-card statement — use import_card_statement.';
  }
  if (source === ImportStatementSource.enum.account) {
    return 'The statement is a bank/wallet account statement — use import_account_statement.';
  }
  return (
    'Ask the user whether this is a credit-card statement (import_card_statement) or a bank/wallet ' +
    'account statement (import_account_statement) before importing.'
  );
};

export const importStatementPromptText = (source: ImportStatementSource | undefined): string =>
  'Ask the user to paste the statement text (or CSV lines) they want to import. ' +
  `${describeStatementSource(source)} After importing, report the created / duplicate / needs_review / ` +
  'error counts, then walk each needs_review item with the user one at a time so they can confirm or ' +
  'correct its category before moving on.';
