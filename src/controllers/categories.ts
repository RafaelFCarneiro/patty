import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import type { Category, CreateCategory, SubCategory } from '../models/category.js'
import type { Deps } from './deps.js'

export const listCategories = (deps: Deps): Promise<Category[]> => deps.categories.list()

export const createCategory = (deps: Deps, input: CreateCategory): ResultAsync<Category, AppError> =>
  safeTry(async function* () {
    const all = await deps.categories.list()
    yield* guard(!all.some((c) => c.name.toLowerCase() === input.name.toLowerCase()), {
      code: 'duplicate_name',
      entity: 'category',
      name: input.name,
    })
    return ok(await deps.categories.create({ id: deps.newId(), ...input }))
  })

export const listSubCategories = (deps: Deps, parentId?: string): Promise<SubCategory[]> =>
  parentId ? deps.subCategories.listByParent(parentId) : deps.subCategories.list()

export const createSubCategory = (
  deps: Deps,
  input: { name: string; parentId: string },
): ResultAsync<SubCategory, AppError> =>
  safeTry(async function* () {
    const siblings = await deps.subCategories.listByParent(input.parentId)
    yield* guard(!siblings.some((s) => s.name.toLowerCase() === input.name.toLowerCase()), {
      code: 'duplicate_name',
      entity: 'sub_category',
      name: input.name,
    })
    return ok(await deps.subCategories.create({ id: deps.newId(), ...input }))
  })
