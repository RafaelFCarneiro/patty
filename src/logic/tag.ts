import * as R from 'remeda';
import type { Persistable } from '../models/persistable.js';
import type { Tag } from '../models/tag.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../models/transactionTag.js';
import { insert } from './persistence.js';

// `transaction_tags` keys on (transactionId, tagId) — a duplicate input name would otherwise
// resolve to a duplicate id and violate that constraint on insert, so dedupe here.
export const resolveTagIds = (names: readonly string[], allTags: readonly Tag[]): string[] => {
  const idByName = new Map(allTags.map((tag) => [tag.name, tag.id]));
  return R.pipe(
    names,
    R.unique(),
    R.map((name) => idByName.get(name)),
    R.filter(R.isNonNullish),
  );
};

/** Same match as `resolveTagIds`, projected as names — a flow's response shows this instead of a
 *  DB round-trip, since `transactionTagApplier` applies after the transaction row's own read-back
 *  in the same batch and so can't reflect it. */
export const resolveTagNames = (names: readonly string[], allTags: readonly Tag[]): string[] => {
  const knownNames = new Set(allTags.map((tag) => tag.name));
  return R.pipe(names, R.unique(), R.filter((name) => knownNames.has(name)));
};

export const tagSetPersistable = (idempotencyKey: string, tagIds: string[]): Persistable =>
  insert({ entity: TRANSACTION_TAG_ENTITY_TAG, model: { idempotencyKey, tagIds } });
