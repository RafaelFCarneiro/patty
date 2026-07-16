import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import {
  assertCategoryNameAvailable,
  assertSubCategoryNameAvailable,
  isCategoryUnreferenced,
  resolveAndSort,
  withKindLabel,
} from '../logic/category.js';
import * as persistence from '../logic/persistence.js';
import {
  categoryErrors,
  CATEGORY_ENTITY_TAG,
  type Category,
  type CategoryWriteModel,
  type CreateCategory,
  type SubCategory,
} from '../models/category.js';
import { notFound } from '../models/error.js';
import type { FlowOutcome } from '../models/persistable.js';
import type { Deps } from './deps.js';
import { resolveCategoryRef, resolveSubCategoryRef } from './resolve.js';

export const listCategories = async (deps: Deps): Promise<Category[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.categories.list()]);
  return resolveAndSort(all, locale).map(withKindLabel(locale));
};

export const createCategory = (deps: Deps, input: CreateCategory): ResultAsync<FlowOutcome<Category>, AppError> =>
  safeTry(async function* () {
    const raw = await deps.categories.list();
    yield* guard(assertCategoryNameAvailable(raw, input.name), categoryErrors.duplicateName('category', input.name));

    const category: CategoryWriteModel = { id: deps.newId(), name: input.name, kind: input.kind, names: null };
    const persist = [persistence.insert({ entity: CATEGORY_ENTITY_TAG, model: category })];
    return ok({ persist, response: category });
  });

export const deleteCategory = (deps: Deps, name: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const category = yield* resolveCategoryRef(deps, name);
    const refs = await deps.categories.countReferences(category.id);
    yield* guard(isCategoryUnreferenced(refs), categoryErrors.inUse('category', category.name, refs));

    const raw = yield* okOr(await deps.categories.findRawById(category.id), notFound('category', category.id, []));
    const persist = [persistence.remove({ entity: CATEGORY_ENTITY_TAG, id: raw.id, version: raw.version })];
    return ok({ persist, response: { deleted: true } });
  });

export const deleteSubCategory = (deps: Deps, name: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const subCategory = yield* resolveSubCategoryRef(deps, name);
    const refs = await deps.subCategories.countReferences(subCategory.id);
    yield* guard(isCategoryUnreferenced(refs), categoryErrors.inUse('sub_category', subCategory.name, refs));

    const raw = yield* okOr(
      await deps.categories.findRawById(subCategory.id),
      notFound('sub_category', subCategory.id, []),
    );
    const persist = [persistence.remove({ entity: CATEGORY_ENTITY_TAG, id: raw.id, version: raw.version })];
    return ok({ persist, response: { deleted: true } });
  });

export const listSubCategories = async (deps: Deps, parentId?: string): Promise<SubCategory[]> => {
  const [locale, subs] = await Promise.all([
    deps.locale(),
    parentId ? deps.subCategories.listByParent(parentId) : deps.subCategories.list(),
  ]);
  return subs.map(withKindLabel(locale));
};

export const createSubCategory = (
  deps: Deps,
  input: { name: string; parentId: string },
): ResultAsync<FlowOutcome<SubCategory>, AppError> =>
  safeTry(async function* () {
    const allCategories = await deps.categories.list();
    const parent = yield* okOr(
      allCategories.find((c) => c.id === input.parentId),
      notFound(
        'category',
        input.parentId,
        allCategories.map((c) => `${c.id} (${c.name})`),
      ),
    );
    const siblings = await deps.subCategories.listByParent(input.parentId);
    yield* guard(
      assertSubCategoryNameAvailable(siblings, input.name),
      categoryErrors.duplicateName('sub_category', input.name),
    );

    const id = deps.newId();
    const entity: CategoryWriteModel = {
      id,
      name: input.name,
      kind: parent.kind,
      parentId: input.parentId,
      names: null,
    };
    const subCategory: SubCategory = {
      id,
      name: input.name,
      parentId: input.parentId,
      parentName: parent.name,
      kind: parent.kind,
    };
    const persist = [persistence.insert({ entity: CATEGORY_ENTITY_TAG, model: entity })];
    return ok({ persist, response: subCategory });
  });
