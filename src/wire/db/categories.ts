import { z } from 'zod';
import type { categories } from '../../diplomat/db/schema.js';
import { LocalizedNamesSchema } from '../../models/category.js';

// Category row from a Drizzle select — derived from schema.ts (single source of truth).
export type CategoryRow = typeof categories.$inferSelect;

// Sub-category row from the raw self-join SELECT (snake_case + joined parent_name).
// Stays a hand schema until the raw reads are unified under drizzle-orm/zod (see migration issue).
export const SubCategoryRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string(),
  parent_name: z.string(),
  kind: z.string(),
});

/** Shared by every raw SQL row that joins in a category's localized `names` JSON column
 *  (aggregate/summary/correlations queries) — decodes the stored JSON string, or `null` when the
 *  join found no category or the category is user-created (`names` is `null` on those rows). */
export const parseCategoryNames = (raw: string | null): Record<string, string> | null =>
  raw ? LocalizedNamesSchema.parse(JSON.parse(raw)) : null;
