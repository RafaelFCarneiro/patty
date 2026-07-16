import { z } from 'zod';
import { IsoDate } from './date.js';
import { Id } from './id.js';
import { CurrencyCode, Money } from './money.js';
import type { LabelMap } from './locale.js';
import { MovementType } from './transaction.js';

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
});
export type RecurringRule = z.infer<typeof RecurringRuleSchema>;

// The recurring-rule aggregate owns its own entity tag (ADR-021), mirroring `models/account.ts`'s
// `ACCOUNT_ENTITY_TAG` — `models/persistable.ts` is generic over any entity's tag/model and never
// lists this constant itself.
export const RECURRING_ENTITY_TAG = 'recurring';

// The persistence-side entity (ADR-021 / functional-core-imperative-shell.md): `RecurringRule` plus
// the optimistic-concurrency `version` token. Never sent over the wire — kept off `RecurringRuleSchema`/
// `RecurringRuleViewSchema` (the display-facing shape `list_recurring`/`create_recurring` return) the
// same way `AccountEntitySchema` stays off `AccountSchema`. Only `applyDueRecurring` (which needs the
// version to build the version-guarded `advance` update) and `adapters/recurring.ts`'s model→row
// adaptation speak `RecurringRuleEntity`.
export const RecurringRuleEntitySchema = RecurringRuleSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
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
});
export type CreateRecurring = z.infer<typeof CreateRecurringSchema>;
