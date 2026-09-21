import { describe, expect, it } from 'vitest';
import { TAG_ENTITY_TAG, TagSchema, type Tag } from '../../../src/models/tag.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '../../../src/effects/persistable.js';
import * as tagsAdapters from '../../../src/adapters/tags.js';

describe('Tag model schema', () => {
  it('rejects empty id', () => {
    expect(() => TagSchema.parse({ id: '', name: 'work' })).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => TagSchema.parse({ id: 'tag-1', name: '' })).toThrow();
  });

  it('accepts valid tag', () => {
    expect(TagSchema.parse({ id: 'tag-1', name: 'work' })).toEqual({ id: 'tag-1', name: 'work' });
  });
});

describe('dbToModel', () => {
  it('maps db node to Tag model', () => {
    const tag = tagsAdapters.dbToModel({ id: 'tag-1', name: 'work', version: 0 });
    expect(tag).toEqual({ id: 'tag-1', name: 'work' });
  });

  // Input is now the schema-derived TagRow, so missing/extra keys are a compile-time
  // error rather than a runtime case. Empty-string rejection is still enforced by TagSchema.parse.
  it('throws when id or name is an empty string', () => {
    expect(() => tagsAdapters.dbToModel({ id: '', name: 'work', version: 0 })).toThrow();
    expect(() => tagsAdapters.dbToModel({ id: 'tag-1', name: '', version: 0 })).toThrow();
  });
});

describe('dbToEntity', () => {
  it('carries version onto the read model (ADR-021)', () => {
    expect(tagsAdapters.dbToEntity({ id: 'tag-1', name: 'work', version: 3 })).toEqual({
      id: 'tag-1',
      name: 'work',
      version: 3,
    });
  });
});

const tag: Tag = { id: 'tag-1', name: 'work' };

describe('persistableToDb (tags) — model→row adaptation lives at the diplomat edge', () => {
  it('insert: bakes in INITIAL_VERSION — the model never carries one', () => {
    const p: Persistable = { op: PersistOp.enum.insert, entity: TAG_ENTITY_TAG, model: tag };
    expect(tagsAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: TAG_ENTITY_TAG,
      model: { ...tag, version: INITIAL_VERSION },
    });
  });

  it('delete: passes through unchanged — there is no model to adapt', () => {
    const p: Persistable = { op: PersistOp.enum.delete, entity: TAG_ENTITY_TAG, id: 'tag-1', version: 3 };
    expect(tagsAdapters.persistableToDb(p)).toEqual(p);
  });

  it('no-ops on a persistable tagged for a different entity', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'account', model: { notATag: true } };
    expect(tagsAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});

describe('outcomeToDb', () => {
  it('maps every persistable in the batch through persistableToDb, leaving response untouched', () => {
    const outcome = {
      persist: [{ op: PersistOp.enum.insert, entity: TAG_ENTITY_TAG, model: tag } as Persistable],
      response: tag,
    };
    expect(tagsAdapters.outcomeToDb(outcome)).toEqual({
      persist: [{ op: PersistOp.enum.insert, entity: TAG_ENTITY_TAG, model: { ...tag, version: INITIAL_VERSION } }],
      response: tag,
    });
  });
});
