import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { hasNameCollision, resolveAndSort, withKindLabel } from '../logic/category.js'
import type { Category, CreateCategory, SubCategory } from '../models/category.js'
import type { Deps } from './deps.js'
import { resolveCategoryRef, resolveSubCategoryRef } from './resolve.js'

export const listCategories = async (deps: Deps): Promise<Category[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.categories.list()])
  return resolveAndSort(all, locale).map(withKindLabel(locale))
}

export const createCategory = (deps: Deps, input: CreateCategory): ResultAsync<Category, AppError> =>
  safeTry(async function* () {
    const raw = await deps.categories.list()
    yield* guard(!hasNameCollision(raw, input.name), {
      code: 'duplicate_name',
      entity: 'category',
      name: input.name,
    })
    return ok(await deps.categories.create({ id: deps.newId(), ...input, names: null }))
  })

export const deleteCategory = (deps: Deps, name: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const category = yield* resolveCategoryRef(deps, name)
    const refs = await deps.categories.countReferences(category.id)
    yield* guard(refs.transactions === 0 && refs.recurring === 0 && refs.subCategories === 0, {
      code: 'in_use',
      entity: 'category',
      name: category.name,
      references: refs,
    })
    await deps.categories.delete(category.id)
    return ok({ deleted: true })
  })

export const deleteSubCategory = (deps: Deps, name: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const subCategory = yield* resolveSubCategoryRef(deps, name)
    const refs = await deps.subCategories.countReferences(subCategory.id)
    yield* guard(refs.transactions === 0 && refs.recurring === 0 && refs.subCategories === 0, {
      code: 'in_use',
      entity: 'sub_category',
      name: subCategory.name,
      references: refs,
    })
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
      allCategories.some((c) => c.id === input.parentId),
      {
        code: 'unknown_category',
        query: input.parentId,
        candidates: allCategories.map((c) => `${c.id} (${c.name})`),
      },
    )
    const siblings = await deps.subCategories.listByParent(input.parentId)
    yield* guard(!siblings.some((s) => s.name.toLowerCase() === input.name.toLowerCase()), {
      code: 'duplicate_name',
      entity: 'sub_category',
      name: input.name,
    })
    return ok(await deps.subCategories.create({ id: deps.newId(), ...input }))
  })
