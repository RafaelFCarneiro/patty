import * as R from 'remeda';
import type { Persistable, PersistOutcome } from '@rfc0/effect-runner';
import type { Tag } from '../models/tag.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../models/transactionTag.js';
import { insert, outcomeFor } from './persistence.js';

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
  return R.pipe(
    names,
    R.unique(),
    R.filter((name) => knownNames.has(name)),
  );
};

export const tagSetPersistable = (transactionId: string, tagIds: string[]): Persistable =>
  insert({ entity: TRANSACTION_TAG_ENTITY_TAG, model: { transactionId, tagIds } });

/** Overlays the core's own matched tag names onto a view — gated on the tag-set `Persistable`'s
 *  OWN outcome, never the transaction write's, since the two can diverge: the tag set no-ops on
 *  any FK miss on its insert, which covers both a duplicate replay (the addressed row was never
 *  inserted) and a tag deleted concurrently between resolution and the batch committing. Either
 *  way, "no tags were written" must not be reported as "these tags are attached". Call only when
 *  a tag-set `Persistable` was actually in the batch — `outcomeFor` throws otherwise. */
export const overlayResolvedTags = <T extends { tags?: string[] }>(
  view: T,
  tagNames: string[],
  outcomes: PersistOutcome[],
): T => (outcomeFor(TRANSACTION_TAG_ENTITY_TAG, outcomes).applied ? { ...view, tags: tagNames } : view);
