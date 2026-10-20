import { errAsync, ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { localizeCategoryName } from '../logic/category.js';
import {
  budgetedCommittedByCurrency,
  groupStatusByCategory,
  hasCategory,
  hasExactlyOneTarget,
  hasSubCategory,
  isExpenseEligible,
  rowsToViews,
  toView,
} from '../logic/budget.js';
import { consolidateInCurrency } from '../logic/currencyRate.js';
import { decimalsLookup } from '../logic/money.js';
import { periodRange } from '../logic/period.js';
import * as persistence from '../logic/persistence.js';
import type { Period } from '../models/date.js';
import {
  budgetErrors,
  BUDGET_ENTITY_TAG,
  type Budget,
  type BudgetEntity,
  type BudgetTarget,
  type BudgetView,
  type CreateBudget,
  type UpdateBudget,
} from '../models/budget.js';
import { notFound } from '../models/error.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { BudgetStatusOut } from '../wire/out/budgets.js';
import type { Deps } from './deps.js';
import { resolveCategoryRef, resolveSubCategoryRef } from './resolve.js';

const resolveBudgetTarget = (
  deps: Deps,
  input: { category?: string; subCategory?: string },
): ResultAsync<BudgetTarget, AppError> =>
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
    () => errAsync<BudgetTarget, AppError>(budgetErrors.targetRequired),
  );

const describeCategoryTarget = (
  deps: Deps,
  categoryId: string,
  locale: Locale,
): ResultAsync<Pick<BudgetTarget, 'category' | 'subCategory'>, AppError> =>
  safeTry(async function* () {
    const categories = await deps.categories.list();
    const category = R.find(categories, (c) => c.id === categoryId);
    if (category) return ok({ category: localizeCategoryName(category.name, category.names, locale) ?? category.name });

    const subCategories = await deps.subCategories.list();
    const subCategory = yield* okOr(
      R.find(subCategories, (s) => s.id === categoryId),
      notFound('category', categoryId, []),
    );
    return ok({ category: subCategory.parentName, subCategory: subCategory.name });
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

    const locale = await deps.locale();
    const target = yield* describeCategoryTarget(deps, existing.categoryId, locale);
    return ok({ persist, response: toView(entity, target) });
  });

export const deleteBudget = (deps: Deps, id: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const existing = await deps.budgets.findById(id);
    if (!existing) return ok({ persist: [], response: { deleted: false } });

    const persist = [persistence.remove({ entity: BUDGET_ENTITY_TAG, id: existing.id, version: existing.version })];
    return ok({ persist, response: { deleted: true } });
  });

export const listBudgets = async (deps: Deps): Promise<BudgetView[]> =>
  R.pipe(await Promise.all([deps.budgets.list(), deps.locale()] as const), ([rows, locale]) =>
    rowsToViews(rows, locale),
  );

export const getBudgetStatus = async (
  deps: Deps,
  periodInput: Period,
  displayCurrency?: CurrencyCode,
): Promise<BudgetStatusOut> => {
  const period: Period = { month: periodInput.month, year: periodInput.year };
  const { from, to } = periodRange(period);
  const [budgets, spend, locale] = await Promise.all([
    deps.budgets.list(),
    deps.transactions.spendByCategory(from, to),
    deps.locale(),
  ] as const);
  const categories = groupStatusByCategory(budgets, spend, locale);
  if (!displayCurrency) return { period, categories };

  const [rates, currencies] = await Promise.all([deps.currencyRates.list(), deps.currencies.list()]);
  const decimalsFor = decimalsLookup(currencies);
  const amounts = budgetedCommittedByCurrency(budgets, spend);
  const converted = consolidateInCurrency(
    amounts,
    displayCurrency,
    rates,
    deps.clock(),
    deps.rateStaleness,
    decimalsFor(displayCurrency),
  );
  return { period, categories, converted: { displayCurrency, ...converted } };
};
