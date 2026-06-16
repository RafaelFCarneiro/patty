import { z } from 'zod'

// Category row from a Drizzle select (id/name/kind are single-token, no casing variance).
export const CategoryRowSchema = z.object({
  id:   z.string(),
  name: z.string(),
  kind: z.string(),
})

// Sub-category row from the raw self-join SELECT (snake_case + joined parent_name).
export const SubCategoryRowSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  parent_id:   z.string(),
  parent_name: z.string(),
  kind:        z.string(),
})
