import { describe, expect, it } from 'vitest';
import { CATEGORY_ENTITY_TAG, CategoryKind, type CategoryWriteModel } from '../../../src/models/category.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '../../../src/models/persistable.js';
import * as wireInCategories from '../../../src/wire/in/categories.js';
import * as categoryAdapters from '../../../src/adapters/categories.js';

describe('dbToModel', () => {
  it('decodes flat SQL row for a category', () => {
    expect(
      categoryAdapters.dbToModel({
        id: 'cat-1',
        name: 'Transport',
        kind: CategoryKind.enum.expense,
        parentId: null,
        names: null,
      }),
    ).toEqual({ id: 'cat-1', name: 'Transport', kind: CategoryKind.enum.expense, names: null });
  });

  it('parses valid JSON names from DB row', () => {
    const result = categoryAdapters.dbToModel({
      id: 'cat-food',
      name: 'Food',
      kind: CategoryKind.enum.expense,
      parentId: null,
      names: '{"pt":"Alimentação","es":"Alimentación"}',
    });
    expect(result.names).toEqual({ pt: 'Alimentação', es: 'Alimentación' });
  });

  it('rejects empty locale key in names', () => {
    expect(() =>
      categoryAdapters.dbToModel({
        id: 'cat-bad',
        name: 'Bad',
        kind: CategoryKind.enum.expense,
        parentId: null,
        names: '{"":"Alimentação"}',
      }),
    ).toThrow();
  });

  it('rejects empty locale value in names', () => {
    expect(() =>
      categoryAdapters.dbToModel({
        id: 'cat-bad',
        name: 'Bad',
        kind: CategoryKind.enum.expense,
        parentId: null,
        names: '{"pt":""}',
      }),
    ).toThrow();
  });

  it('throws on invalid JSON in names', () => {
    expect(() =>
      categoryAdapters.dbToModel({
        id: 'cat-broken',
        name: 'Broken',
        kind: CategoryKind.enum.expense,
        parentId: null,
        names: '{not valid json}',
      }),
    ).toThrow(SyntaxError);
  });
});

describe('wireInToModel', () => {
  it('applies expense kind default when omitted', () => {
    const parsed = wireInCategories.CreateCategorySchema.parse({ name: 'Salário' });
    expect(categoryAdapters.wireInToModel(parsed)).toEqual({ name: 'Salário', kind: CategoryKind.enum.expense });
  });

  it('preserves explicit kind when provided', () => {
    const parsed = wireInCategories.CreateCategorySchema.parse({ name: 'Salário', kind: CategoryKind.enum.income });
    expect(categoryAdapters.wireInToModel(parsed)).toEqual({ name: 'Salário', kind: CategoryKind.enum.income });
  });
});

const category: CategoryWriteModel = { id: 'cat-1', name: 'Transport', kind: CategoryKind.enum.expense, names: null };
const subCategory: CategoryWriteModel = {
  id: 'sub-1',
  name: 'Bus',
  kind: CategoryKind.enum.expense,
  parentId: 'cat-1',
  names: null,
};

describe('modelToDb', () => {
  it('carries every field, including version and null parentId, onto a top-level category row', () => {
    expect(categoryAdapters.modelToDb({ ...category, version: 3 })).toEqual({
      id: 'cat-1',
      name: 'Transport',
      kind: CategoryKind.enum.expense,
      parentId: null,
      names: null,
      version: 3,
    });
  });

  it('carries parentId onto a sub-category row', () => {
    expect(categoryAdapters.modelToDb({ ...subCategory, version: 0 })).toEqual({
      id: 'sub-1',
      name: 'Bus',
      kind: CategoryKind.enum.expense,
      parentId: 'cat-1',
      names: null,
      version: 0,
    });
  });

  it('serializes names as JSON', () => {
    const withNames: CategoryWriteModel = { ...category, names: { pt: 'Transporte' } };
    expect(categoryAdapters.modelToDb({ ...withNames, version: 0 }).names).toBe('{"pt":"Transporte"}');
  });
});

describe('persistableToDb — ADR-021 follow-up: model→row adaptation lives at the diplomat edge', () => {
  it('insert: bakes in INITIAL_VERSION — the model never carries one', () => {
    const p: Persistable = { op: PersistOp.enum.insert, entity: CATEGORY_ENTITY_TAG, model: category };
    expect(categoryAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: CATEGORY_ENTITY_TAG,
      model: {
        id: 'cat-1',
        name: 'Transport',
        kind: CategoryKind.enum.expense,
        parentId: null,
        names: null,
        version: INITIAL_VERSION,
      },
    });
  });

  it('insert: a sub-category insert carries parentId onto the row', () => {
    const p: Persistable = { op: PersistOp.enum.insert, entity: CATEGORY_ENTITY_TAG, model: subCategory };
    expect(categoryAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: CATEGORY_ENTITY_TAG,
      model: {
        id: 'sub-1',
        name: 'Bus',
        kind: CategoryKind.enum.expense,
        parentId: 'cat-1',
        names: null,
        version: INITIAL_VERSION,
      },
    });
  });

  it('delete: passes through unchanged — there is no model to adapt', () => {
    const p: Persistable = { op: PersistOp.enum.delete, entity: CATEGORY_ENTITY_TAG, id: 'cat-1', version: 2 };
    expect(categoryAdapters.persistableToDb(p)).toEqual(p);
  });

  it('no-ops on a persistable tagged for a different entity', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'account', model: { notACategory: true } };
    expect(categoryAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});

describe('outcomeToDb', () => {
  it('maps every persistable in the batch through persistableToDb, leaving response untouched', () => {
    const outcome = {
      persist: [{ op: PersistOp.enum.insert, entity: CATEGORY_ENTITY_TAG, model: category } as Persistable],
      response: category,
    };
    const adapted = categoryAdapters.outcomeToDb(outcome);
    expect(adapted.response).toEqual(category);
    expect(adapted.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: CATEGORY_ENTITY_TAG,
        model: {
          id: 'cat-1',
          name: 'Transport',
          kind: CategoryKind.enum.expense,
          parentId: null,
          names: null,
          version: INITIAL_VERSION,
        },
      },
    ]);
  });
});
