import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';
import { CURSOR_VERSION, encodeCursor, SortDirection } from '../../../src/models/page.js';
import {
  ClassificationMethod,
  TransactionSortField,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  TransactionViewSchema,
} from '../../../src/models/transaction.js';
import type { RawTransactionView } from '../../../src/models/transaction.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  deriveIdempotencyKey,
  hasCategory,
  hasSubCategory,
  isCategoryKindAllowed,
  needsReview,
  nextCursorAfter,
  resolveCursorKey,
  resolveEffectiveType,
  summarizeBulkItems,
} from '../../../src/logic/transaction.js';

describe('deriveIdempotencyKey', () => {
  it('is stable for the same statement line', () => {
    const item = { date: '2026-06-09', description: 'PAG*UberTrip 99-SP', amount: 32.5 };
    expect(deriveIdempotencyKey(item)).toBe('2026-06-09-ubertrip-sp-32.50');
    expect(deriveIdempotencyKey(item)).toBe(deriveIdempotencyKey({ ...item }));
  });

  it('differs when amount differs', () => {
    const a = { date: '2026-06-09', description: 'IFOOD', amount: 30 };
    expect(deriveIdempotencyKey(a)).not.toBe(deriveIdempotencyKey({ ...a, amount: 31 }));
  });
});

describe('needsReview', () => {
  it('flags unclassified and low-confidence', () => {
    expect(needsReview({ method: 'none', confidence: 0 })).toBe(true);
    expect(needsReview({ method: 'history', confidence: 0.55 })).toBe(true);
    expect(needsReview({ method: 'rule', confidence: 0.8 })).toBe(false);
    expect(needsReview({ method: 'user', confidence: 1 })).toBe(false);
  });
});

describe('resolveEffectiveType', () => {
  it('uses input.type when provided', () => {
    expect(resolveEffectiveType({ type: 'expense' }, { type: 'income' })).toBe('income');
  });

  it('falls back to existing type', () => {
    expect(resolveEffectiveType({ type: 'expense' }, {})).toBe('expense');
  });

  it('returns undefined for transfers', () => {
    expect(resolveEffectiveType({ type: 'transfer' }, {})).toBeUndefined();
  });
});

describe('summarizeBulkItems', () => {
  const tx = TransactionViewSchema.parse({
    id: 'tx-1',
    description: 'Test',
    amount: 1,
    type: 'expense',
    status: TransactionStatus.enum.effective,
    date: '2026-01-01',
    currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp,
    idempotencyKey: 'k1',
    classification: { method: 'none', confidence: 0 },
  });

  it('counts each status correctly', () => {
    const items = [
      { status: 'created' as const, transaction: tx, classification: { method: 'user' as const, confidence: 1 } },
      { status: 'needs_review' as const, transaction: tx, classification: { method: 'none' as const, confidence: 0 } },
      { status: 'needs_review' as const, transaction: tx, classification: { method: 'none' as const, confidence: 0 } },
      { status: 'duplicate' as const, transaction: tx },
      { status: 'error' as const, description: 'x', error: { code: 'validation' as const, issues: [] } },
    ];
    expect(summarizeBulkItems(items)).toEqual({ created: 1, needsReview: 2, duplicates: 1, errors: 1 });
  });

  it('returns all zeros for empty input', () => {
    expect(summarizeBulkItems([])).toEqual({ created: 0, needsReview: 0, duplicates: 0, errors: 0 });
  });
});

describe('addLocalizedLabels', () => {
  const baseTx: RawTransactionView = {
    id: 'tx-1',
    description: 'Test',
    amount: 100,
    type: TransactionType.enum.expense,
    status: TransactionStatus.enum.effective,
    date: '2026-01-01',
    currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp,
    idempotencyKey: 'test-1',
    classification: { method: ClassificationMethod.enum.none, confidence: 0 },
    tags: [],
  };

  it('adds typeLabel and statusLabel for the given locale', () => {
    const labeled = addLocalizedLabels(baseTx, Locale.enum.pt);
    expect(labeled.typeLabel).toBe('Despesa');
    expect(labeled.statusLabel).toBe('Efetivada');
  });

  it('preserves original enum values', () => {
    const labeled = addLocalizedLabels(baseTx, Locale.enum.es);
    expect(labeled.type).toBe(TransactionType.enum.expense);
    expect(labeled.status).toBe(TransactionStatus.enum.effective);
  });

  it('resolves categoryName from categoryNames map for active locale', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação', es: 'Alimentación' },
    };
    const labeled = addLocalizedLabels(tx, Locale.enum.pt);
    expect(labeled.categoryName).toBe('Alimentação');
  });

  it('resolves subCategoryName from subCategoryNames map', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      subCategoryName: 'Groceries',
      subCategoryNames: { pt: 'Supermercado', es: 'Supermercado' },
    };
    const labeled = addLocalizedLabels(tx, Locale.enum.pt);
    expect(labeled.subCategoryName).toBe('Supermercado');
  });

  it('falls back to canonical name when locale has no translation', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
    };
    const labeled = addLocalizedLabels(tx, Locale.enum.es);
    expect(labeled.categoryName).toBe('Food');
  });

  it('keeps literal name for user-created categories (names null)', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      categoryName: 'My Custom',
      categoryNames: null,
    };
    const labeled = addLocalizedLabels(tx, Locale.enum.pt);
    expect(labeled.categoryName).toBe('My Custom');
  });

  it('strips categoryNames and subCategoryNames from output', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
      subCategoryName: 'Groceries',
      subCategoryNames: { pt: 'Supermercado' },
    };
    const labeled = addLocalizedLabels(tx, Locale.enum.pt);
    expect(labeled.categoryNames).toBeUndefined();
    expect(labeled.subCategoryNames).toBeUndefined();
  });

  it('leaves categoryName undefined when no category assigned', () => {
    const labeled = addLocalizedLabels(baseTx, Locale.enum.pt);
    expect(labeled.categoryName).toBeUndefined();
  });

  it('categoryId is unchanged by locale resolution', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      categoryId: 'cat-food',
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
    };
    const labeled = addLocalizedLabels(tx, Locale.enum.pt);
    expect(labeled.categoryId).toBe('cat-food');
  });

  it('works as a curried mapper (purry data-last)', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
    };
    const mapper = addLocalizedLabels(Locale.enum.pt);
    const labeled = mapper(tx);
    expect(labeled.categoryName).toBe('Alimentação');
    expect(labeled.categoryNames).toBeUndefined();
  });
});

describe('isCategoryKindAllowed', () => {
  it('allows both-kind categories for any transaction type', () => {
    expect(isCategoryKindAllowed('expense', 'both')).toBe(true);
    expect(isCategoryKindAllowed('income', 'both')).toBe(true);
  });

  it('allows matching kind', () => {
    expect(isCategoryKindAllowed('expense', 'expense')).toBe(true);
    expect(isCategoryKindAllowed('income', 'income')).toBe(true);
  });

  it('rejects expense category for income transaction', () => {
    expect(isCategoryKindAllowed('income', 'expense')).toBe(false);
  });

  it('rejects income category for expense transaction', () => {
    expect(isCategoryKindAllowed('expense', 'income')).toBe(false);
  });
});

describe('assertExclusiveCategorySubCategory', () => {
  it('passes when only category is provided', () => {
    expect(assertExclusiveCategorySubCategory({ category: 'C' })).toBe(true);
  });

  it('passes when only subCategory is provided', () => {
    expect(assertExclusiveCategorySubCategory({ subCategory: 'S' })).toBe(true);
  });

  it('fails when both are provided', () => {
    expect(assertExclusiveCategorySubCategory({ category: 'C', subCategory: 'S' })).toBe(false);
  });

  // Value-based (via hasCategory/hasSubCategory), not truthiness — an explicitly empty string is
  // still "provided", so this combination must be caught as a violation, not silently let through.
  it('fails when category is an empty string and subCategory is also provided', () => {
    expect(assertExclusiveCategorySubCategory({ category: '', subCategory: 'S' })).toBe(false);
  });
});

describe('hasCategory / hasSubCategory', () => {
  it('hasCategory is true only when category is present', () => {
    expect(hasCategory({ category: 'C' })).toBe(true);
    expect(hasCategory({})).toBe(false);
    expect(hasCategory({ subCategory: 'S' })).toBe(false);
  });

  it('hasSubCategory is true only when subCategory is present', () => {
    expect(hasSubCategory({ subCategory: 'S' })).toBe(true);
    expect(hasSubCategory({})).toBe(false);
    expect(hasSubCategory({ category: 'C' })).toBe(false);
  });

  // isNonNullish-based, not truthiness — at the pure-predicate level an empty string is still
  // non-nullish ("provided"); it's CategoryFieldsSchema's .min(1) that rejects '' at the boundary
  // before it can ever reach this predicate in a real request.
  it('treats an empty string as provided, not as absent', () => {
    expect(hasCategory({ category: '' })).toBe(true);
    expect(hasSubCategory({ subCategory: '' })).toBe(true);
  });

  // isNonNullish over !== undefined specifically to also treat null as absent — the field's type
  // never allows null, but a caller-constructed object bypassing the type system could still pass
  // one, and `null !== undefined` would otherwise (wrongly) count it as provided.
  it('treats null as absent, unlike a plain !== undefined check', () => {
    expect(hasCategory({ category: null as unknown as string })).toBe(false);
    expect(hasSubCategory({ subCategory: null as unknown as string })).toBe(false);
  });
});

describe('resolveCursorKey', () => {
  const { date, amount } = TransactionSortField.enum;
  const { asc, desc } = SortDirection.enum;

  it('returns null when no cursor is given (first page)', () => {
    const result = resolveCursorKey({ cursor: undefined, sort: date, dir: desc });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('decodes a well-formed cursor matching the request sort/dir', () => {
    const cursor = encodeCursor({ v: CURSOR_VERSION, sort: date, dir: desc, key: { value: '2026-06-01', id: 'tx-1' } });
    const result = resolveCursorKey({ cursor, sort: date, dir: desc });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ value: '2026-06-01', id: 'tx-1' });
  });

  it('rejects a malformed cursor', () => {
    const result = resolveCursorKey({ cursor: 'not-a-real-cursor', sort: date, dir: desc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a cursor whose sort does not match the request', () => {
    const cursor = encodeCursor({ v: CURSOR_VERSION, sort: date, dir: desc, key: { value: '2026-06-01', id: 'tx-1' } });
    const result = resolveCursorKey({ cursor, sort: amount, dir: desc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a cursor whose dir does not match the request', () => {
    const cursor = encodeCursor({ v: CURSOR_VERSION, sort: date, dir: desc, key: { value: '2026-06-01', id: 'tx-1' } });
    const result = resolveCursorKey({ cursor, sort: date, dir: asc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  // A tampered cursor could decode structurally (right shape) but carry a value type that
  // doesn't match its own sort field (e.g. a number where sort: date implies a date string) —
  // that must be rejected here, not silently reach the keyset predicate and mispage.
  it('rejects a cursor whose key value type does not match sort: date (expects a string)', () => {
    const cursor = encodeCursor({ v: CURSOR_VERSION, sort: date, dir: desc, key: { value: 20260601, id: 'tx-1' } });
    const result = resolveCursorKey({ cursor, sort: date, dir: desc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a cursor whose key value type does not match sort: amount (expects a number)', () => {
    const cursor = encodeCursor({ v: CURSOR_VERSION, sort: amount, dir: desc, key: { value: '42.50', id: 'tx-1' } });
    const result = resolveCursorKey({ cursor, sort: amount, dir: desc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  // Right JS type, wrong content — a string that isn't a real ISO date must still be rejected,
  // not just any string.
  it('rejects a cursor whose sort: date value is a string but not a valid ISO date', () => {
    const cursor = encodeCursor({ v: CURSOR_VERSION, sort: date, dir: desc, key: { value: 'not-a-date', id: 'tx-1' } });
    const result = resolveCursorKey({ cursor, sort: date, dir: desc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  // Right JS type, wrong content — the JSON numeral 1e309 parses (JSON.parse, not JS source) as
  // the number Infinity (still `typeof 'number'`), which must still be rejected, not just any
  // number. Built from a raw JSON string, not encodeCursor: constructing the payload as a JS
  // object literal first would already collapse Infinity to null via JSON.stringify, before the
  // cursor was ever encoded — that's a different bug than the one under test here.
  it('rejects a cursor whose sort: amount value is a non-finite number', () => {
    const rawJson = `{"v":${CURSOR_VERSION},"sort":"amount","dir":"desc","key":{"value":1e309,"id":"tx-1"}}`;
    const cursor = Buffer.from(rawJson, 'utf8').toString('base64url');
    const result = resolveCursorKey({ cursor, sort: amount, dir: desc });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('nextCursorAfter', () => {
  const { date, amount } = TransactionSortField.enum;
  const { desc } = SortDirection.enum;
  const row = { id: 'tx-9', date: '2026-06-01', amount: 42.5 };

  it('encodes the date value for sort: date', () => {
    const cursor = nextCursorAfter(row, date, desc);
    const result = resolveCursorKey({ cursor, sort: date, dir: desc });
    expect(result._unsafeUnwrap()).toEqual({ value: '2026-06-01', id: 'tx-9' });
  });

  it('encodes the amount value for sort: amount', () => {
    const cursor = nextCursorAfter(row, amount, desc);
    const result = resolveCursorKey({ cursor, sort: amount, dir: desc });
    expect(result._unsafeUnwrap()).toEqual({ value: 42.5, id: 'tx-9' });
  });
});
