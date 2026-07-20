import * as R from 'remeda';
import type { Persistable } from '../models/persistable.js';
import type { Tag } from '../models/tag.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../models/transactionTag.js';
import { insert } from './persistence.js';

/** Resolves user-supplied tag names to ids against the full tag list — a name with no matching
 *  row is silently dropped (ADR-023 decision 3): leniency preserved by decision, now stated here
 *  with a test, rather than a side effect of a DB `inArray` missing. Pure — the caller reads
 *  `deps.tags.list()` once and hands it in. */
export const resolveTagIds = (names: readonly string[], allTags: readonly Tag[]): string[] => {
  const idByName = new Map(allTags.map((tag) => [tag.name, tag.id]));
  return R.pipe(
    names,
    R.map((name) => idByName.get(name)),
    R.filter(R.isNonNullish),
  );
};

/** Resolves user-supplied tag names to the subset that actually matched a real tag — the same
 *  match `resolveTagIds` computes, projected as names instead of ids. A flow's response shows
 *  this (not a DB round-trip): `transactionTagApplier` applies later in the same batch than the
 *  transaction row's own read-back (`diplomat/db/repos/transactions.ts`'s `fetchTx`), so that read
 *  can't yet reflect a tag-set write still to come — the core already knows the matched set
 *  without reading anything back. */
export const resolveTagNames = (names: readonly string[], allTags: readonly Tag[]): string[] => {
  const knownNames = new Set(allTags.map((tag) => tag.name));
  return R.filter(names, (name) => knownNames.has(name));
};

/** The transaction's full desired tag-set `Persistable` (ADR-023 decision 3) — a set-replace, not
 *  a row update; no `id`/`version`, like `merchant_category`. Addressed by `idempotencyKey`, not
 *  the transaction's own (freshly-minted-per-call) id — see `models/transactionTag.ts`. */
export const tagSetPersistable = (idempotencyKey: string, tagIds: string[]): Persistable =>
  insert({ entity: TRANSACTION_TAG_ENTITY_TAG, model: { idempotencyKey, tagIds } });
