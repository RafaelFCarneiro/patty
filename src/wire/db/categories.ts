import { z } from 'zod'
import type { categories } from '../../diplomat/db/schema.js'

// Category row from a Drizzle select — derived from schema.ts (single source of truth).
export type CategoryRow = typeof categories.$inferSelect

// Sub-category row from the raw self-join SELECT (snake_case + joined parent_name).
// Stays a hand schema until the raw reads are unified under drizzle-orm/zod (see migration issue).
export const SubCategoryRowSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  parent_id:   z.string(),
  parent_name: z.string(),
  kind:        z.string(),
})
