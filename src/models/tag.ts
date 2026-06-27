import { z } from 'zod'
import type { DuplicateName } from './error.js'

export const Tag = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})
export type Tag = z.infer<typeof Tag>

export type TagError = DuplicateName<'tag'>

export const tagErrors = {
  duplicateName: (name: string): TagError => ({ code: 'duplicate_name', entity: 'tag', name }),
}
