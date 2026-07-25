import { z } from 'zod';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';
import type { NotFound, ValidationError } from './error.js';

export const BudgetPeriod = z.enum(['monthly']);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

// Entity tag for this aggregate's `Persistable`s.
export const BUDGET_ENTITY_TAG = 'budget';

/** Write-shape: the budgeted node's own id (a top-level category or sub-category — both rows in
 *  `categories`), never a display name. `limit` is this module's own vocabulary for the `limit_amount`
 *  column (adapters/budgets.ts maps the rename). */
export const BudgetSchema = z.object({
  id: Id.describe('Unique budget identifier'),
  categoryId: Id.describe("The budgeted node's id — a top-level category or sub-category (categories.id)"),
  currency: CurrencyCode.describe(
    'Currency this limit is denominated in; spend is measured same-currency only (no implicit conversion)',
  ),
  limit: z.number().positive().describe('Spending limit for the period, full units of currency'),
  period: BudgetPeriod.describe('How often the limit applies; monthly is the only period for now'),
});
export type Budget = z.infer<typeof BudgetSchema>;

// `Budget` plus the optimistic-concurrency `version` token. Never sent over the wire.
export const BudgetEntitySchema = BudgetSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type BudgetEntity = z.infer<typeof BudgetEntitySchema>;

/** Read projection actually returned to callers — `category`/`subCategory` display names instead
 *  of the internal `categoryId` FK, mirroring `RecurringRuleView` (models/recurring.ts). */
export const BudgetViewSchema = BudgetSchema.omit({ categoryId: true }).extend({
  category: z.string().min(1).describe("Top-level category name — the sub-category's parent, when set"),
  subCategory: z
    .string()
    .min(1)
    .optional()
    .describe('Sub-category name, present only when this budget targets a sub-category rather than its parent'),
});
export type BudgetView = z.infer<typeof BudgetViewSchema>;

// `.describe()` is domain information. Defaults split by intent: integrity defaults live here
// (`period` is required — a real value the domain always needs); quality-of-life convenience
// defaults live at the wire boundary (`wire/in/budgets.ts` defaults `period` to `monthly`),
// mirroring `models/category.ts`'s `CreateCategorySchema`/`wire/in/categories.ts` split.
export const CreateBudgetSchema = z.object({
  category: z
    .string()
    .min(1)
    .optional()
    .describe('Category name to budget — provide exactly one of category/subCategory'),
  subCategory: z
    .string()
    .min(1)
    .optional()
    .describe('Sub-category name to budget — provide exactly one of category/subCategory'),
  currency: CurrencyCode.describe('Currency this limit is denominated in and measured against'),
  limit: z.number().positive().describe('Spending limit for the period, full units of currency'),
  period: BudgetPeriod.describe('How often the limit applies'),
});
export type CreateBudget = z.infer<typeof CreateBudgetSchema>;

export const UpdateBudgetSchema = z.object({
  id: Id.describe('Budget id, from create_budget or list_budgets'),
  limit: z.number().positive().optional().describe('New spending limit'),
  period: BudgetPeriod.optional().describe('New period'),
});
export type UpdateBudget = z.infer<typeof UpdateBudgetSchema>;

export type BudgetError =
  | NotFound<'budget'>
  | ValidationError
  | { code: 'not_expense_category'; category: string }
  | { code: 'duplicate_budget'; category: string; subCategory?: string; currency: CurrencyCode; period: BudgetPeriod };

export const budgetErrors = {
  targetRequired: {
    code: 'validation',
    issues: ['exactly one of category or subCategory is required'],
  } satisfies BudgetError,
  notExpenseCategory: (category: string): BudgetError => ({ code: 'not_expense_category', category }),
  duplicate: (
    target: { category: string; subCategory?: string },
    currency: CurrencyCode,
    period: BudgetPeriod,
  ): BudgetError => ({
    code: 'duplicate_budget',
    category: target.category,
    subCategory: target.subCategory,
    currency,
    period,
  }),
};
