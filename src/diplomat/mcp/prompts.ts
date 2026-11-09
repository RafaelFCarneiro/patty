import { z } from 'zod';
import { type Period, PeriodSchema } from '../../models/date.js';
import type { Scoped } from '../../controllers/deps.js';
import { getTourContext } from '../../controllers/demo/tour.js';
import { ImportStatementSource, PromptName } from '../../models/prompts.js';
import { definePrompt, type PromptDefinition } from './definition.js';
import { tourPromptText } from './tour.js';
import { ToolName } from './tool-name.js';

const T = ToolName.enum;

/** Guided-workflow MCP prompts (Feature Design 019) — orchestration text; the *model* executes the tools the text
 *  instructs it to call. Only `tour` reads the database (through `controllers/demo/tour.ts`). The trivial date
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

type PeriodArgs = { month?: number; year?: number };

const formatPeriod = ({ month, year }: Period): string => `${pad(month)}/${year}`;

const CURRENCY_RULE =
  'Group every figure by currency and never sum across currencies — BRL and USD are always reported separately.';

export const monthlyReviewPromptText = (period: Period): string =>
  `You are reviewing the user's finances for ${formatPeriod(period)}. Call ${T.get_spending_summary}, ` +
  `${T.find_correlations} with analysis "spending_shifts", then "budget_fit", then "recurring_candidates" ` +
  `(all scoped to month ${period.month} year ${period.year}), and ${T.get_budget_status} for the same period. ` +
  'Then write a brief, prose review — no raw table dumps: per-currency income/expenses/balance; the 2-3 ' +
  'biggest category shifts vs the baseline and a plausible driver for each; which budgets are over or have ' +
  `slack; and any recurring-payment candidates worth turning into a rule via ${T.create_recurring}. ${CURRENCY_RULE}`;

export const budgetCheckupPromptText = (period: Period): string =>
  `You are checking the user's budgets for ${formatPeriod(period)}. Call ${T.get_budget_status} and ` +
  `${T.find_correlations} with analysis "budget_fit" (both scoped to month ${period.month} year ${period.year}). ` +
  'Report which budgets are on track, over, or generous; surface each suggestedLimit; and flag any ' +
  'unbudgeted category with a significant, established spend pattern. Offer to apply a suggestion — with ' +
  `the user's say-so, call ${T.update_budget} (existing budget) or ${T.create_budget} (unbudgeted category) with the ` +
  `suggested limit. ${CURRENCY_RULE}`;

const describeStatementSource = (source: ImportStatementSource | undefined): string => {
  if (source === ImportStatementSource.enum.card) {
    return `The statement is a credit-card statement — use ${T.import_card_statement}.`;
  }
  if (source === ImportStatementSource.enum.account) {
    return `The statement is a bank/wallet account statement — use ${T.import_account_statement}.`;
  }
  return (
    `Ask the user whether this is a credit-card statement (${T.import_card_statement}) or a bank/wallet ` +
    `account statement (${T.import_account_statement}) before importing.`
  );
};

export const importStatementPromptText = (source: ImportStatementSource | undefined): string =>
  'Ask the user to paste the statement text (or CSV lines) they want to import. ' +
  `${describeStatementSource(source)} After importing, report the created / duplicate / needs_review / ` +
  'error counts, then walk each needs_review item with the user one at a time so they can confirm or ' +
  'correct its category before moving on.';

const periodPrompt =
  (text: (period: Period) => string) =>
  async ({ month, year }: PeriodArgs, { deps }: Scoped) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: text(resolvePromptPeriod({ month, year }, deps.clock())) },
      },
    ],
  });

const monthlyReviewPrompt = definePrompt({
  name: PromptName.enum.monthly_review,
  config: {
    title: 'Monthly financial review',
    description:
      'Synthesize a per-currency monthly review: spending summary, the biggest shifts vs baseline, ' +
      'budget fit, and recurring-payment candidates worth automating.',
    argsSchema: PeriodPromptArgsSchema,
  },
  handle: periodPrompt(monthlyReviewPromptText),
});

const budgetCheckupPrompt = definePrompt({
  name: PromptName.enum.budget_checkup,
  config: {
    title: 'Budget checkup',
    description:
      'Report which budgets are on track, over, or generous, surface suggested limits and unbudgeted ' +
      'significant spend, and offer to apply the suggestions.',
    argsSchema: PeriodPromptArgsSchema,
  },
  handle: periodPrompt(budgetCheckupPromptText),
});

const importStatementPrompt = definePrompt({
  name: PromptName.enum.import_statement,
  config: {
    title: 'Import a statement',
    description:
      'Walk the user through pasting a card or account statement, importing it, and confirming any ' +
      'needs_review items.',
    argsSchema: ImportStatementPromptArgsSchema,
  },
  handle: async ({ source }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: importStatementPromptText(source) } }],
  }),
});

/** Takes no arguments: the demo's language, country and trip come from the database (Feature Design 022 §6). */
const tourPrompt = definePrompt({
  name: PromptName.enum.tour,
  config: {
    title: 'Tour of the PATTY demo',
    description:
      'A six-step guided tour of the demo (balances, last month, budgets, a statement import, tagging the seeded ' +
      'trip and building a dashboard, then installing for real). On a real database it only says how to start the demo.',
  },
  handle: async (_args, { deps }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: tourPromptText(await getTourContext(deps)) } }],
  }),
});

/** Guided-workflow prompts (Feature Design 019, 022) — few and cross-domain, one module (ADR-025). */
export const promptDefinitions: PromptDefinition[] = [
  monthlyReviewPrompt,
  budgetCheckupPrompt,
  importStatementPrompt,
  tourPrompt,
];
