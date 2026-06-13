import { z } from 'zod'

export const Tag = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})
export type Tag = z.infer<typeof Tag>
