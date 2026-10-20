import * as R from 'remeda';
import type { Persistable, PersistOutcome } from '@rfc0/effect-runner';
import type { Tag } from '../models/tag.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../models/transactionTag.js';
import { insert, outcomeFor } from './persistence.js';

export const resolveTagIds = (names: readonly string[], allTags: readonly Tag[]): string[] => {
  const idByName = new Map(allTags.map((tag) => [tag.name, tag.id]));
  return R.pipe(
    names,
    R.unique(),
    R.map((name) => idByName.get(name)),
    R.filter(R.isNonNullish),
  );
};

export const resolveTagNames = (names: readonly string[], allTags: readonly Tag[]): string[] => {
  const knownNames = new Set(allTags.map((tag) => tag.name));
  return R.pipe(
    names,
    R.unique(),
    R.filter((name) => knownNames.has(name)),
  );
};

export const tagSetPersistable = (transactionId: string, tagIds: string[]): Persistable =>
  insert({ entity: TRANSACTION_TAG_ENTITY_TAG, model: { transactionId, tagIds } });

export const overlayResolvedTags = <T extends { tags?: string[] }>(
  view: T,
  tagNames: string[],
  outcomes: PersistOutcome[],
): T => (outcomeFor(TRANSACTION_TAG_ENTITY_TAG, outcomes).applied ? { ...view, tags: tagNames } : view);
