import { z } from 'zod'
import { Id } from './common.js'

export const CategoryKind = z.enum(['expense', 'income', 'both'])
export type CategoryKind = z.infer<typeof CategoryKind>

export const Category = z.object({
  id: Id,
  name: z.string().min(1),
  kind: CategoryKind,
})
export type Category = z.infer<typeof Category>

export type CreateCategory = {
  name: string
  kind: CategoryKind
}
