import { describe, expect, it } from 'vitest';
import { PersistenceMeta, withPersistenceMeta } from '../../../src/models/persistable.js';
import { TagSchema } from '../../../src/models/tag.js';

describe('withPersistenceMeta', () => {
  it('adds a version field carrying the canonical describe', () => {
    const schema = withPersistenceMeta(TagSchema);
    expect(schema.shape.version.description).toBe(PersistenceMeta.shape.version.description);
  });

  it('accepts a model plus a non-negative version, rejects a negative one', () => {
    const schema = withPersistenceMeta(TagSchema);
    expect(schema.safeParse({ id: 'tag-1', name: 'Groceries', version: 0 }).success).toBe(true);
    expect(schema.safeParse({ id: 'tag-1', name: 'Groceries', version: -1 }).success).toBe(false);
  });
});

describe('a pure model', () => {
  it('strips a version key even when the input carries one (regression pin against leakage onto the model)', () => {
    const parsed = TagSchema.parse({ id: 'tag-1', name: 'Groceries', version: 3 });
    expect('version' in parsed).toBe(false);
  });
});
