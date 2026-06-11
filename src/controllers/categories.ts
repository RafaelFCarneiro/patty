import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import type { Category, CreateCategory } from '../models/category.js'
import type { Deps } from './deps.js'

export const listCategories = (deps: Deps): Promise<Category[]> => deps.categories.list()

export const createCategory = async (
  deps: Deps,
  input: CreateCategory,
): Promise<Result<Category, AppError>> => {
  const all = await deps.categories.list()
  if (all.some((c) => c.name.toLowerCase() === input.name.toLowerCase()))
    return err({ code: 'duplicate_name', entity: 'category', name: input.name })
  const category = await deps.categories.create({ id: deps.newId(), ...input })
  return ok(category)
}
