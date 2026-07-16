import { z } from 'zod';
import { Id } from './id.js';
import type { DuplicateName } from './error.js';

export const TagSchema = z.object({
  id: Id.describe('Unique tag identifier'),
  name: z.string().min(1).describe('Tag display name'),
});
export type Tag = z.infer<typeof TagSchema>;

// The tag aggregate owns its own entity tag (ADR-021), mirroring `models/account.ts`'s
// `ACCOUNT_ENTITY_TAG` — `models/persistable.ts` is generic over any entity's tag/model and never
// lists this constant itself.
export const TAG_ENTITY_TAG = 'tag';

// The persistence-side entity (ADR-021): `Tag` plus the optimistic-concurrency `version` token.
// Never sent over the wire — only flows that build `Persistable`s (`deleteTag`) and
// `adapters/tags.ts`'s model→row adaptation speak `TagEntity`.
export const TagEntitySchema = TagSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type TagEntity = z.infer<typeof TagEntitySchema>;

export type TagError = DuplicateName<'tag'>;

export const tagErrors = {
  duplicateName: (name: string): TagError => ({ code: 'duplicate_name', entity: 'tag', name }),
};
