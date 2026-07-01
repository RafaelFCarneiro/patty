import { z } from 'zod';
import { Id } from './id.js';
import type { DuplicateName } from './error.js';

export const TagSchema = z.object({
  id: Id.describe('Unique tag identifier'),
  name: z.string().min(1).describe('Tag display name'),
});
export type Tag = z.infer<typeof TagSchema>;

export type TagError = DuplicateName<'tag'>;

export const tagErrors = {
  duplicateName: (name: string): TagError => ({ code: 'duplicate_name', entity: 'tag', name }),
};
