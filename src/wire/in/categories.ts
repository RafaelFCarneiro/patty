import { z } from 'zod'
import { CategoryKind } from '../../models/category.js'
import type { CreateCategory as Domain } from '../../models/category.js'

export const CreateCategory = z
  .object({
    name: z.string().min(1),
    kind: CategoryKind.optional(),
  })
  .transform((input): Domain => ({
    name: input.name,
    kind: input.kind ?? 'expense',
  }))
export type CreateCategory = z.infer<typeof CreateCategory>
