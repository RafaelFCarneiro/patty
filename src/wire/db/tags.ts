import type { tags } from '../../diplomat/db/schema.js'

// Tag row from a Drizzle select — derived from schema.ts (single source of truth).
export type TagRow = typeof tags.$inferSelect
