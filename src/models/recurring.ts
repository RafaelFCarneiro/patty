import { z } from 'zod';
import { IsoDate } from './date.js';
import { Id } from './id.js';
import { CurrencyCode, Money } from './money.js';
import { withPersistenceMeta, type Persistable } from '@rfc0/effect-runner';
import type { LabelMap } from './locale.js';
import { MovementType, type MerchantMatch, type TransactionView } from './transaction.js';

export const RecurringPeriod = z.enum(['weekly', 'monthly', 'yearly']);
export type RecurringPeriod = z.infer<typeof RecurringPeriod>;

export const recurringPeriodLabels: LabelMap<RecurringPeriod> = {
  weekly: { en: 'Weekly', pt: 'Semanal', es: 'Semanal' },
  monthly: { en: 'Monthly', pt: 'Mensal', es: 'Mensual' },
  yearly: { en: 'Yearly', pt: 'Anual', es: 'Anual' },
};

// `.describe()` is domain information — it states what each field is and represents.
// Defaults split by intent: integrity defaults (a value that must exist for the entity to be
// valid) live here; quality-of-life convenience defaults live at the wire boundary,
// keeping the domain contract honest about what is required.
export const RecurringRuleSchema = z.object({
  id: Id,
  description: z.string().min(1).describe('What this rule pays for (rent, salary, subscription…)'),
  amount: Money.describe('Recurring amount in full units'),
  type: MovementType.describe('expense | income'),
  period: RecurringPeriod.describe('How often the rule fires'),
  nextDue: IsoDate.describe('Next date this rule should materialize a transaction'),
  currency: CurrencyCode.describe('Currency for materialized transactions'),
  accountId: Id.optional().describe('Target account for materialized transactions'),
  categoryId: Id.optional().describe('Category for materialized transactions'),
  merchantKey: z.string().min(1).optional().describe('Normalized merchant key this rule pays, if known'),
});
export type RecurringRule = z.infer<typeof RecurringRuleSchema>;

export const RECURRING_ENTITY_TAG = 'recurring';

// Never sent over the wire — kept off `RecurringRuleSchema`/`RecurringRuleViewSchema` the same way
// `AccountEntitySchema` stays off `AccountSchema`.
export const RecurringRuleEntitySchema = withPersistenceMeta(RecurringRuleSchema);
export type RecurringRuleEntity = z.infer<typeof RecurringRuleEntitySchema>;

export const RecurringRuleViewSchema = RecurringRuleSchema.extend({
  periodLabel: z.string().optional().describe('Localized period label'),
  accountName: z.string().optional().describe('Resolved account name'),
  categoryName: z.string().optional().describe('Resolved category name'),
});
export type RecurringRuleView = z.infer<typeof RecurringRuleViewSchema>;

export const CreateRecurringSchema = z.object({
  description: z.string().min(1).describe('What this rule pays for (rent, salary, subscription…)'),
  amount: Money.describe('Recurring amount in full units'),
  type: MovementType.describe('expense | income'),
  period: RecurringPeriod.describe('How often the rule fires'),
  startDate: IsoDate.describe('First due date (YYYY-MM-DD)'),
  account: z.string().optional().describe('Account name (resolved by name match)'),
  category: z.string().optional().describe('Category name (resolved by name match)'),
  currency: CurrencyCode.optional().describe('Currency (resolved from account if omitted)'),
  merchant: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Merchant this rule pays (e.g. "Netflix", the landlord) — normalized the same way as a ' +
        'transaction description; omit to derive it from `description` instead',
    ),
});
export type CreateRecurring = z.infer<typeof CreateRecurringSchema>;

export type RuleFacts = {
  id: string;
  input: CreateRecurring;
  account: { id: string; currency: CurrencyCode } | null;
  category: { id: string } | null;
  candidates: readonly MerchantMatch[];
};

export type ApplyDueResult = {
  applied: Array<{ rule: string; date: string; transaction: TransactionView }>;
  count: number;
};

export type RulePlan = {
  occurrences: Array<{ rule: string; date: string; persistable: Persistable }>;
  advance: Persistable;
};

export const MAX_RECURRING_OCCURRENCES_PER_RUN = 36;

export type DueSchedule = {
  dates: readonly string[];
  next: string;
};
