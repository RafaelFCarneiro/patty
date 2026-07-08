/**
 * Unit tests for updateTransaction delta construction and outcome→error mapping (ADR-015).
 *
 * These tests verify the controller's logic in isolation — the delta it builds and the error
 * it returns when applyUpdate reports a conflict — without touching the DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { updateTransaction } from '../../../src/controllers/transactions.js';
import { Locale } from '../../../src/models/locale.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '../../../src/models/transaction.js';
import type { RawTransactionView, TransactionUpdateDelta, UpdateOutcome } from '../../../src/models/transaction.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { Category } from '../../../src/models/category.js';

// A minimal RawTransactionView for controller tests — only fields the controller reads.
const makeExisting = (overrides?: Partial<RawTransactionView>): RawTransactionView => ({
  id: 'tx-1',
  description: 'Coffee',
  amount: 5,
  type: TransactionType.enum.expense,
  status: TransactionStatus.enum.effective,
  date: '2026-06-15',
  currency: 'BRL',
  source: TransactionSource.enum.mcp,
  idempotencyKey: 'ik-1',
  classification: { method: ClassificationMethod.enum.none, confidence: 0 },
  tags: [],
  categoryId: undefined,
  cardId: undefined,
  billId: undefined,
  ...overrides,
});

const makeCategory = (id: string, name: string): Category => ({
  id,
  name,
  kind: 'both',
  parentId: undefined,
  names: null,
});

// Capture the delta passed to applyUpdate so we can assert on it.
const makeDeps = (
  existing: RawTransactionView,
  outcome: UpdateOutcome,
  capturedDelta: { value?: TransactionUpdateDelta } = {},
  categories: Category[] = [],
): Deps => ({
  transactions: {
    getById: async () => existing,
    applyUpdate: async (_id, delta, _newId) => {
      capturedDelta.value = delta;
      return outcome;
    },
  } as unknown as Deps['transactions'],
  accounts: {
    list: async () => [],
  } as unknown as Deps['accounts'],
  creditCards: {
    list: async () => [],
    findById: async () => null,
  } as unknown as Deps['creditCards'],
  categories: {
    list: async () => categories,
  } as unknown as Deps['categories'],
  subCategories: {
    list: async () => [],
  } as unknown as Deps['subCategories'],
  bills: {
    findByCycle: async () => null,
    findById: async () => null,
  } as unknown as Deps['bills'],
  merchants: {} as Deps['merchants'],
  locale: async () => Locale.enum.en,
  clock: () => new Date('2026-06-15'),
  newId: () => 'new-id',
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  resetLocale: vi.fn(),
});

const appliedOutcome = (row: RawTransactionView): UpdateOutcome => ({ applied: true, row });
const conflictOutcome: UpdateOutcome = { applied: false, conflict: 'bill_paid' };

describe('updateTransaction — delta construction', () => {
  it('builds a delta with only changed scalar fields (patch)', async () => {
    const existing = makeExisting();
    const captured: { value?: TransactionUpdateDelta } = {};
    const deps = makeDeps(existing, appliedOutcome({ ...existing, description: 'Tea', amount: 3 }), captured);

    await updateTransaction(deps, { id: 'tx-1', description: 'Tea', amount: 3 });

    expect(captured.value?.patch.description).toBe('Tea');
    expect(captured.value?.patch.amount).toBe(3);
    expect(captured.value?.patch.type).toBeUndefined();
    expect(captured.value?.patch.date).toBeUndefined();
  });

  it('sets classificationStrengthen when category changes', async () => {
    const existing = makeExisting({ categoryId: 'cat-old' });
    const captured: { value?: TransactionUpdateDelta } = {};
    const cat = makeCategory('cat-new', 'Food');
    const deps = makeDeps(
      existing,
      appliedOutcome({ ...existing, categoryId: 'cat-new' }),
      captured,
      [cat],
    );

    await updateTransaction(deps, { id: 'tx-1', category: 'Food' });

    expect(captured.value?.classificationStrengthen).toEqual({ categoryId: 'cat-new' });
    expect(captured.value?.patch.classification).toEqual({
      method: ClassificationMethod.enum.user,
      confidence: 1,
    });
  });

  it('omits classificationStrengthen when category is unchanged', async () => {
    const existing = makeExisting({ categoryId: 'cat-same' });
    const captured: { value?: TransactionUpdateDelta } = {};
    const cat = makeCategory('cat-same', 'Food');
    const deps = makeDeps(existing, appliedOutcome(existing), captured, [cat]);

    await updateTransaction(deps, { id: 'tx-1', category: 'Food' });

    expect(captured.value?.classificationStrengthen).toBeUndefined();
  });

  it('sets tagNames in refs when tags are provided', async () => {
    const existing = makeExisting();
    const captured: { value?: TransactionUpdateDelta } = {};
    const deps = makeDeps(existing, appliedOutcome(existing), captured);

    await updateTransaction(deps, { id: 'tx-1', tags: ['work', 'travel'] });

    expect(captured.value?.refs.tagNames).toEqual(['work', 'travel']);
  });

  it('sets tagNames to null (no-op) when tags are omitted', async () => {
    const existing = makeExisting();
    const captured: { value?: TransactionUpdateDelta } = {};
    const deps = makeDeps(existing, appliedOutcome(existing), captured);

    await updateTransaction(deps, { id: 'tx-1', description: 'Tea' });

    expect(captured.value?.refs.tagNames).toBeNull();
  });

  it('sets subCategoryId to null (explicit clear) when only a category is given', async () => {
    const existing = makeExisting({ categoryId: 'cat-old', subCategoryId: 'subcat-old' });
    const captured: { value?: TransactionUpdateDelta } = {};
    const cat = makeCategory('cat-new', 'Food');
    const deps = makeDeps(
      existing,
      appliedOutcome({ ...existing, categoryId: 'cat-new', subCategoryId: undefined }),
      captured,
      [cat],
    );

    await updateTransaction(deps, { id: 'tx-1', category: 'Food' });

    expect(captured.value?.refs.subCategoryId).toBeNull();
  });

  it('leaves subCategoryId undefined (untouched) when no category fields given', async () => {
    const existing = makeExisting({ subCategoryId: 'subcat-existing' });
    const captured: { value?: TransactionUpdateDelta } = {};
    const deps = makeDeps(existing, appliedOutcome(existing), captured);

    await updateTransaction(deps, { id: 'tx-1', description: 'Tea' });

    expect(captured.value?.refs.subCategoryId).toBeUndefined();
  });
});

describe('updateTransaction — outcome → AppError mapping', () => {
  it('returns ok when applyUpdate reports applied: true', async () => {
    const existing = makeExisting();
    const deps = makeDeps(existing, appliedOutcome({ ...existing, description: 'Tea' }));

    const result = await updateTransaction(deps, { id: 'tx-1', description: 'Tea' });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().description).toBe('Tea');
  });

  it('maps conflict: bill_paid to paidBillImmutable validation error', async () => {
    // The existing transaction has a card but no bill (so the source-bill pre-check passes).
    // The target bill pre-check also passes (findByCycle returns null = no bill yet).
    // applyUpdate itself then returns the CAS conflict (concurrent pay_bill landed).
    const existing = makeExisting({ cardId: 'card-1' });
    const captured: { value?: TransactionUpdateDelta } = {};
    const deps = makeDeps(existing, conflictOutcome, captured);
    deps.creditCards = {
      list: async () => [],
      findById: async (id: string) =>
        id === 'card-1'
          ? { id: 'card-1', name: 'My Card', currency: 'BRL', closingDay: 28, dueDay: 5, accountId: 'acc-1' }
          : null,
    } as unknown as Deps['creditCards'];

    const result = await updateTransaction(deps, {
      id: 'tx-1',
      billMonth: 7,
      billYear: 2026,
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as { issues?: string[] }).issues?.[0]).toContain('revert_bill_payment');
  });
});
