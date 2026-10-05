import { describe, expect, it } from 'vitest';
import { createTag, deleteTag } from '../../../src/controllers/tags.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { PersistOp } from '@rfc0/effect-runner';
import { TAG_ENTITY_TAG, type Tag, type TagEntity } from '../../../src/models/tag.js';
import { Locale } from '../../../src/models/locale.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: { findByName: async () => null, findById: async () => null } as unknown as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'tag-id-1',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  ...overrides,
});

const tagEntity = (overrides: Partial<TagEntity> = {}): TagEntity => ({
  id: 'tag-existing',
  name: 'work',
  version: 4,
  ...overrides,
});

describe('createTag — functional core (ADR-021 phase 3a)', () => {
  it("returns an insert Persistable for the tag — no version, that is the shell's to decide", async () => {
    const deps = makeDeps();

    const result = await createTag(deps, 'work');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.insert, entity: TAG_ENTITY_TAG, model: { id: 'tag-id-1', name: 'work' } },
    ]);
    expect(outcome.response).toEqual({ id: 'tag-id-1', name: 'work' } satisfies Tag);
  });

  it('rejects a duplicate tag name before building any Persistable', async () => {
    const deps = makeDeps({
      tags: { findByName: async () => ({ id: 'tag-existing', name: 'work' }) } as unknown as Deps['tags'],
    });

    const result = await createTag(deps, 'work');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'tag', name: 'work' });
  });
});

describe('deleteTag — functional core (ADR-021 phase 3a)', () => {
  it('returns a version-guarded remove Persistable when the tag exists', async () => {
    const deps = makeDeps({
      tags: { findById: async () => tagEntity() } as unknown as Deps['tags'],
    });

    const result = await deleteTag(deps, 'tag-existing');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: TAG_ENTITY_TAG, id: 'tag-existing', version: 4 },
    ]);
    expect(outcome.response).toEqual({ deleted: true });
  });

  it('returns deleted:false with an empty batch when the id does not exist (unchanged behavior)', async () => {
    const deps = makeDeps({ tags: { findById: async () => null } as unknown as Deps['tags'] });

    const result = await deleteTag(deps, 'nonexistent');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toEqual({ deleted: false });
  });
});
