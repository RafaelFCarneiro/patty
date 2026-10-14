import { describe, expect, it, vi } from 'vitest';
import {
  createCategory,
  createSubCategory,
  deleteCategory,
  deleteSubCategory,
} from '../../../src/controllers/categories.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { CATEGORY_ENTITY_TAG, CategoryKind, type Category, type SubCategory } from '../../../src/models/category.js';
import { PersistOp } from '@rfc0/effect-runner';
import { Locale } from '../../../src/models/locale.js';
import { SHARED_DEFAULT_READ_ONLY_MESSAGE } from '../../../src/models/tenancy.js';

const category = (overrides: Partial<Category> = {}): Category => ({
  id: 'cat-food',
  name: 'Food',
  kind: CategoryKind.enum.expense,
  names: null,
  ...overrides,
});

const subCategory = (overrides: Partial<SubCategory> = {}): SubCategory => ({
  id: 'sub-bus',
  name: 'Bus',
  parentId: 'cat-food',
  parentName: 'Food',
  kind: CategoryKind.enum.expense,
  ...overrides,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {
    list: async () => [category()],
    countReferences: async () => ({ transactions: 0, recurring: 0, subCategories: 0 }),
    findRawById: async () => ({ id: 'cat-food', version: 5, shared: false }),
  } as unknown as Deps['categories'],
  subCategories: {
    list: async () => [subCategory()],
    listByParent: async () => [subCategory()],
    countReferences: async () => ({ transactions: 0, recurring: 0, subCategories: 0 }),
  } as unknown as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'new-id-1',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  ...overrides,
});

describe('createCategory — functional core (ADR-021 phase 3a)', () => {
  it('returns an insert Persistable and a response with no version', async () => {
    const deps = makeDeps({
      categories: { list: async () => [] } as unknown as Deps['categories'],
    });

    const result = await createCategory(deps, { name: 'Transport', kind: CategoryKind.enum.expense });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: CATEGORY_ENTITY_TAG,
        model: { id: 'new-id-1', name: 'Transport', kind: CategoryKind.enum.expense, names: null },
      },
    ]);
    expect(outcome.response).toEqual({
      id: 'new-id-1',
      name: 'Transport',
      kind: CategoryKind.enum.expense,
      names: null,
    });
  });

  it('rejects a duplicate category name before building any Persistable', async () => {
    const deps = makeDeps({
      categories: { list: async () => [category({ name: 'Food' })] } as unknown as Deps['categories'],
    });

    const result = await createCategory(deps, { name: 'food', kind: CategoryKind.enum.expense });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'category', name: 'food' });
  });
});

describe('deleteCategory — functional core (ADR-021 phase 3a)', () => {
  it('returns a version-guarded remove Persistable for an unreferenced category', async () => {
    const deps = makeDeps();

    const result = await deleteCategory(deps, 'Food');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: CATEGORY_ENTITY_TAG, id: 'cat-food', version: 5 },
    ]);
    expect(outcome.response).toEqual({ deleted: true });
  });

  it('rejects when referenced (in_use)', async () => {
    const deps = makeDeps({
      categories: {
        list: async () => [category()],
        countReferences: async () => ({ transactions: 3, recurring: 0, subCategories: 0 }),
        findRawById: async () => ({ id: 'cat-food', version: 5, shared: false }),
      } as unknown as Deps['categories'],
    });

    const result = await deleteCategory(deps, 'Food');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'in_use',
      entity: 'category',
      name: 'Food',
      references: { transactions: 3, recurring: 0, subCategories: 0 },
    });
  });
});

describe('shared defaults are read-only (ADR-033 §5)', () => {
  it('refuses to delete a default category with the read-only message, before counting its references', async () => {
    const countReferences = vi.fn();
    const deps = makeDeps({
      categories: {
        list: async () => [category()],
        countReferences,
        findRawById: async () => ({ id: 'cat-food', version: 5, shared: true }),
      } as unknown as Deps['categories'],
    });

    const result = await deleteCategory(deps, 'Food');

    expect(result._unsafeUnwrapErr()).toEqual({ code: 'validation', issues: [SHARED_DEFAULT_READ_ONLY_MESSAGE] });
    expect(countReferences).not.toHaveBeenCalled();
  });

  it('refuses to delete a default sub-category the same way', async () => {
    const deps = makeDeps({
      categories: {
        findRawById: async () => ({ id: 'sub-bus', version: 1, shared: true }),
      } as unknown as Deps['categories'],
    });

    const result = await deleteSubCategory(deps, 'Bus');

    expect(result._unsafeUnwrapErr()).toEqual({ code: 'validation', issues: [SHARED_DEFAULT_READ_ONLY_MESSAGE] });
  });
});

describe('createSubCategory — functional core (ADR-021 phase 3a)', () => {
  it('inherits the parent kind and returns an insert Persistable carrying parentId', async () => {
    const deps = makeDeps({ subCategories: { listByParent: async () => [] } as unknown as Deps['subCategories'] });

    const result = await createSubCategory(deps, { name: 'Bus', parentId: 'cat-food' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: CATEGORY_ENTITY_TAG,
        model: {
          id: 'new-id-1',
          name: 'Bus',
          kind: CategoryKind.enum.expense,
          parentId: 'cat-food',
          names: null,
        },
      },
    ]);
    expect(outcome.response).toEqual({
      id: 'new-id-1',
      name: 'Bus',
      parentId: 'cat-food',
      parentName: 'Food',
      kind: CategoryKind.enum.expense,
    });
  });

  it('rejects an unknown parentId', async () => {
    const deps = makeDeps();

    const result = await createSubCategory(deps, { name: 'Bus', parentId: 'does-not-exist' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_category');
  });

  it('rejects a duplicate sibling name', async () => {
    const deps = makeDeps({
      subCategories: { listByParent: async () => [subCategory({ name: 'Bus' })] } as unknown as Deps['subCategories'],
    });

    const result = await createSubCategory(deps, { name: 'bus', parentId: 'cat-food' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'sub_category', name: 'bus' });
  });
});

describe('deleteSubCategory — functional core (ADR-021 phase 3a)', () => {
  it('returns a version-guarded remove Persistable, reading version off the shared categories table', async () => {
    const deps = makeDeps({
      categories: {
        findRawById: async () => ({ id: 'sub-bus', version: 1, shared: false }),
      } as unknown as Deps['categories'],
    });

    const result = await deleteSubCategory(deps, 'Bus');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: CATEGORY_ENTITY_TAG, id: 'sub-bus', version: 1 },
    ]);
    expect(outcome.response).toEqual({ deleted: true });
  });

  it('rejects when referenced (in_use)', async () => {
    const deps = makeDeps({
      subCategories: {
        list: async () => [subCategory()],
        countReferences: async () => ({ transactions: 1, recurring: 0, subCategories: 0 }),
      } as unknown as Deps['subCategories'],
    });

    const result = await deleteSubCategory(deps, 'Bus');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'in_use',
      entity: 'sub_category',
      name: 'Bus',
      references: { transactions: 1, recurring: 0, subCategories: 0 },
    });
  });
});
