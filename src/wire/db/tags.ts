import { z } from 'zod'

// Tag row from a Drizzle select. Loose; Tag.parse enforces non-empty id/name downstream.
export const TagRowSchema = z.object({
  id:   z.string(),
  name: z.string(),
})
