import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import type { Category, CreateCategory } from '../models/category.js'
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
