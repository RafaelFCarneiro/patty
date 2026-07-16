import { z } from 'zod';
import { Id } from './id.js';
import type { DuplicateName } from './error.js';

export const TagSchema = z.object({
  id: Id.describe('Unique tag identifier'),
  name: z.string().min(1).describe('Tag display name'),
});
export type Tag = z.infer<typeof TagSchema>;

// Entity tag for this aggregate's `Persistable`s.
export const TAG_ENTITY_TAG = 'tag';

// `Tag` plus the optimistic-concurrency `version` token. Never sent over the wire.
export const TagEntitySchema = TagSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type TagEntity = z.infer<typeof TagEntitySchema>;

export type TagError = DuplicateName<'tag'>;

export const tagErrors = {
  duplicateName: (name: string): TagError => ({ code: 'duplicate_name', entity: 'tag', name }),
};
