import { errAsync, ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { hasCategory, hasExactlyOneTarget, hasSubCategory, isExpenseEligible } from '../logic/budget.js';
import * as persistence from '../logic/persistence.js';
import type { CategoryKind } from '../models/category.js';
import {
  budgetErrors,
  BUDGET_ENTITY_TAG,
  type Budget,
  type BudgetEntity,
  type BudgetView,
  type CreateBudget,
  type UpdateBudget,
} from '../models/budget.js';
import { notFound } from '../models/error.js';
import type { FlowOutcome } from '../models/persistable.js';
import type { Deps } from './deps.js';
import { resolveCategoryRef, resolveSubCategoryRef } from './resolve.js';

type ResolvedTarget = { id: string; category: string; subCategory?: string; kind: CategoryKind };

/** Resolves the budgeted node by name — a top-level category or sub-category — reusing the same
 *  `resolveCategoryRef`/`resolveSubCategoryRef` transactions resolve through (`controllers/
 *  resolve.ts`), dispatched the same way `resolveCategorySelection` (`controllers/transaction/
 *  core.ts`) dispatches, but always required: budgets have no "leave unset" meaning. */
const resolveBudgetTarget = (
  deps: Deps,
  input: { category?: string; subCategory?: string },
): ResultAsync<ResolvedTarget, AppError> =>
  R.conditional(
    input,
    [
      hasSubCategory,
      (i) =>
        resolveSubCategoryRef(deps, i.subCategory).map((sub) => ({
          id: sub.id,
          category: sub.parentName,
          subCategory: sub.name,
          kind: sub.kind,
        })),
    ],
    [
      hasCategory,
      (i) => resolveCategoryRef(deps, i.category).map((cat) => ({ id: cat.id, category: cat.name, kind: cat.kind })),
    ],
    // Unreachable once `hasExactlyOneTarget` has guarded the caller — kept so `R.conditional` stays
    // exhaustive rather than throwing on a missing match.
    () => errAsync<ResolvedTarget, AppError>(budgetErrors.targetRequired),
  );

/** `findById` only carries the budgeted node's id (`categoryId`), never its display name —
 *  `updateBudget`'s response still needs one, so this re-derives it the same way `createBudget`'s
 *  in-memory `resolveBudgetTarget` result already has it, without re-resolving by name. */
const describeCategoryTarget = async (
  deps: Deps,
  categoryId: string,
): Promise<{ category: string; subCategory?: string }> => {
  const top = await deps.categories.list();
  const category = R.find(top, (c) => c.id === categoryId);
  if (category) return { category: category.name };

  const subCategories = await deps.subCategories.list();
  const subCategory = R.find(subCategories, (s) => s.id === categoryId);
  if (!subCategory) throw new Error(`describeCategoryTarget: no category or sub-category found for id "${categoryId}"`);
  return { category: subCategory.parentName, subCategory: subCategory.name };
};

const toView = (budget: Pick<Budget, 'id' | 'currency' | 'limit' | 'period'>, target: { category: string; subCategory?: string }): BudgetView => ({
  id: budget.id,
  currency: budget.currency,
  limit: budget.limit,
  period: budget.period,
  category: target.category,
  subCategory: target.subCategory,
});

export const createBudget = (deps: Deps, input: CreateBudget): ResultAsync<FlowOutcome<BudgetView>, AppError> =>
  safeTry(async function* () {
    yield* guard(hasExactlyOneTarget(input), budgetErrors.targetRequired);
    const target = yield* resolveBudgetTarget(deps, input);
    yield* guard(
      isExpenseEligible(target.kind),
      budgetErrors.notExpenseCategory(target.subCategory ?? target.category),
    );

    yield* guard(
      !(await deps.budgets.findByTarget(target.id, input.currency, input.period)),
      budgetErrors.duplicate(target, input.currency, input.period),
    );

    const budget: Budget = {
      id: deps.newId(),
      categoryId: target.id,
      currency: input.currency,
      limit: input.limit,
      period: input.period,
    };
    const persist = [persistence.insert({ entity: BUDGET_ENTITY_TAG, model: budget })];
    return ok({ persist, response: toView(budget, target) });
  });

export const updateBudget = (deps: Deps, input: UpdateBudget): ResultAsync<FlowOutcome<BudgetView>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.budgets.findById(input.id), notFound('budget', input.id, []));
    const entity: BudgetEntity = {
      ...existing,
      limit: input.limit ?? existing.limit,
      period: input.period ?? existing.period,
    };
    const persist = R.isDeepEqual(entity, existing)
      ? []
      : [persistence.update({ entity: BUDGET_ENTITY_TAG, model: entity })];

    const target = await describeCategoryTarget(deps, existing.categoryId);
    return ok({ persist, response: toView(entity, target) });
  });

/** Delete by id is idempotent-by-design — a missing budget returns `{ deleted: false }` rather than
 *  an error, with an empty `persist` batch (no write). Mirrors `deleteTag`/`deleteDashboard`. */
export const deleteBudget = (deps: Deps, id: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const existing = await deps.budgets.findById(id);
    if (!existing) return ok({ persist: [], response: { deleted: false } });

    const persist = [persistence.remove({ entity: BUDGET_ENTITY_TAG, id: existing.id, version: existing.version })];
    return ok({ persist, response: { deleted: true } });
  });

export const listBudgets = (deps: Deps): Promise<BudgetView[]> => deps.budgets.list();
