import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { assertCategoryNameAvailable, assertSubCategoryNameAvailable, isUnreferenced, parentExists, resolveAndSort, withKindLabel } from '../logic/category.js'
import { categoryErrors, type Category, type CreateCategory, type SubCategory } from '../models/category.js'
import { notFound } from '../models/error.js'
import type { Deps } from './deps.js'
import { resolveCategoryRef, resolveSubCategoryRef } from './resolve.js'

export const listCategories = async (deps: Deps): Promise<Category[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.categories.list()])
  return resolveAndSort(all, locale).map(withKindLabel(locale))
}

export const createCategory = (deps: Deps, input: CreateCategory): ResultAsync<Category, AppError> =>
  safeTry(async function* () {
    const raw = await deps.categories.list()
    yield* guard(assertCategoryNameAvailable(raw, input.name), categoryErrors.duplicateName('category', input.name))
    return ok(await deps.categories.create({ id: deps.newId(), ...input, names: null }))
  })

export const deleteCategory = (deps: Deps, name: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const category = yield* resolveCategoryRef(deps, name)
    const refs = await deps.categories.countReferences(category.id)
    yield* guard(isUnreferenced(refs), categoryErrors.inUse('category', category.name, refs))
    await deps.categories.delete(category.id)
    return ok({ deleted: true })
  })

export const deleteSubCategory = (deps: Deps, name: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const subCategory = yield* resolveSubCategoryRef(deps, name)
    const refs = await deps.subCategories.countReferences(subCategory.id)
    yield* guard(isUnreferenced(refs), categoryErrors.inUse('sub_category', subCategory.name, refs))
    await deps.subCategories.delete(subCategory.id)
    return ok({ deleted: true })
  })

export const listSubCategories = async (deps: Deps, parentId?: string): Promise<SubCategory[]> => {
  const [locale, subs] = await Promise.all([
    deps.locale(),
    parentId ? deps.subCategories.listByParent(parentId) : deps.subCategories.list(),
  ])
  return subs.map(withKindLabel(locale))
}

export const createSubCategory = (
  deps: Deps,
  input: { name: string; parentId: string },
): ResultAsync<SubCategory, AppError> =>
  safeTry(async function* () {
    const allCategories = await deps.categories.list()
    yield* guard(
      parentExists(allCategories, input.parentId),
      notFound('category', input.parentId, allCategories.map((c) => `${c.id} (${c.name})`)),
    )
    const siblings = await deps.subCategories.listByParent(input.parentId)
    yield* guard(assertSubCategoryNameAvailable(siblings, input.name),
      categoryErrors.duplicateName('sub_category', input.name))
    return ok(await deps.subCategories.create({ id: deps.newId(), ...input }))
  })
