import { z } from 'zod';
import type { categories } from '../../diplomat/db/schema.js';
import { LocalizedNamesSchema } from '../../models/category.js';
import type { WithoutOwner } from './tenancy.js';

// Category row from a Drizzle select — derived from schema.ts (single source of truth).
export type CategoryRow = WithoutOwner<typeof categories.$inferSelect>;

// Sub-category row from the raw self-join SELECT (snake_case + joined parent_name).
// Stays a hand schema until the raw reads are unified under drizzle-orm/zod (see migration issue).
export const SubCategoryRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string(),
  parent_name: z.string(),
  kind: z.string(),
});

/** Decodes a joined category's `names` JSON column — `null` when the join found no category or
 *  the category is user-created. Shared by aggregate/summary/correlations queries. */
export const parseCategoryNames = (raw: string | null): Record<string, string> | null =>
  raw ? LocalizedNamesSchema.parse(JSON.parse(raw)) : null;
