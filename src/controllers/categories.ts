import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { hasNameCollision, resolveDisplayName } from '../logic/category.js'
import type { Category, CreateCategory, SubCategory } from '../models/category.js'
import type { Deps } from './deps.js'

export const listCategories = async (deps: Deps): Promise<Category[]> => {
  const locale = await deps.locale()
  const all = await deps.categories.list()
  const resolved = all.map((c) => resolveDisplayName(c, locale))
  const collator = new Intl.Collator(locale, { sensitivity: 'base' })
  return resolved.sort((a, b) => collator.compare(a.name, b.name))
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

export const listSubCategories = (deps: Deps, parentId?: string): Promise<SubCategory[]> =>
  parentId ? deps.subCategories.listByParent(parentId) : deps.subCategories.list()

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
