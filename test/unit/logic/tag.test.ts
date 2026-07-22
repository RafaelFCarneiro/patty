import { describe, expect, it } from 'vitest';
import { overlayResolvedTags, resolveTagIds, resolveTagNames, tagSetPersistable } from '../../../src/logic/tag.js';
import { PersistOp, type PersistOutcome } from '../../../src/models/persistable.js';
import type { Tag } from '../../../src/models/tag.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../../../src/models/transactionTag.js';

const allTags: Tag[] = [
  { id: 'tag-work', name: 'work' },
  { id: 'tag-travel', name: 'travel' },
];

describe('resolveTagIds — name→id resolution, leniency preserved by decision (ADR-023 decision 3)', () => {
  it('resolves every name when all match', () => {
    expect(resolveTagIds(['work', 'travel'], allTags)).toEqual(['tag-work', 'tag-travel']);
  });

  it('drops names with no matching tag, keeping the ones that do match', () => {
    expect(resolveTagIds(['work', 'does-not-exist'], allTags)).toEqual(['tag-work']);
  });

  it('resolves to an empty list when no name matches', () => {
    expect(resolveTagIds(['nope', 'also-nope'], allTags)).toEqual([]);
  });

  it('resolves to an empty list for an empty name list', () => {
    expect(resolveTagIds([], allTags)).toEqual([]);
  });

  it('resolves to an empty list against an empty tag catalog', () => {
    expect(resolveTagIds(['work'], [])).toEqual([]);
  });

  it('dedupes a repeated name to a single id — transaction_tags keys on (transactionId, tagId)', () => {
    expect(resolveTagIds(['work', 'work'], allTags)).toEqual(['tag-work']);
  });
});

describe('resolveTagNames — the matched-name projection a flow response shows directly', () => {
  it('resolves every name when all match', () => {
    expect(resolveTagNames(['work', 'travel'], allTags)).toEqual(['work', 'travel']);
  });

  it('drops names with no matching tag, keeping the ones that do match', () => {
    expect(resolveTagNames(['work', 'does-not-exist'], allTags)).toEqual(['work']);
  });

  it('resolves to an empty list when no name matches', () => {
    expect(resolveTagNames(['nope'], allTags)).toEqual([]);
  });

  it('resolves to an empty list for an empty name list', () => {
    expect(resolveTagNames([], allTags)).toEqual([]);
  });

  it('dedupes a repeated name, staying consistent with the deduped ids persisted', () => {
    expect(resolveTagNames(['work', 'work'], allTags)).toEqual(['work']);
  });
});

describe('tagSetPersistable — builds the transaction tag-set insert (ADR-023 decision 3)', () => {
  it('builds an insert Persistable carrying the transaction id and resolved tag ids', () => {
    expect(tagSetPersistable('tx-1', ['tag-work'])).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      model: { transactionId: 'tx-1', tagIds: ['tag-work'] },
    });
  });

  it('builds one even with an empty tag set — a set-replace to "no tags", not skipped', () => {
    expect(tagSetPersistable('tx-1', [])).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      model: { transactionId: 'tx-1', tagIds: [] },
    });
  });
});

describe('overlayResolvedTags — gated on the tag-set outcome, never the transaction write\'s (review fix)', () => {
  it('overlays the matched names when the tag-set Persistable applied', () => {
    const outcomes: PersistOutcome[] = [{ entity: TRANSACTION_TAG_ENTITY_TAG, applied: true }];
    expect(overlayResolvedTags({ tags: ['stale'] }, ['work'], outcomes)).toEqual({ tags: ['work'] });
  });

  it('leaves the view untouched when the tag set no-op\'d — whatever the reason', () => {
    // Covers both a duplicate replay AND a tag deleted concurrently between resolution and the
    // batch committing: `transactionTagApplier` reports `applied: false` for either, and this
    // must not be read as "these names are attached" regardless of cause.
    const outcomes: PersistOutcome[] = [{ entity: TRANSACTION_TAG_ENTITY_TAG, applied: false }];
    expect(overlayResolvedTags({ tags: ['surviving'] }, ['work'], outcomes)).toEqual({ tags: ['surviving'] });
  });

  it('throws if no tag-set outcome is in the batch — a batch-composition bug, never silent', () => {
    expect(() => overlayResolvedTags({ tags: [] }, ['work'], [])).toThrow(
      'no persist outcome found for entity "transactionTag"',
    );
  });
});
