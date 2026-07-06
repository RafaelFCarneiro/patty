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
  assertBillAssignmentHasCard,
  assertBillPeriodPaired,
  assertExclusiveAccountCard,
  assertExclusiveCategorySubCategory,
  deriveIdempotencyKey,
  guardTransferMutability,
  hasCategory,
  hasSubCategory,
  isCategoryKindAllowed,
  needsReview,
  nextCursorAfter,
  resolveCurrency,
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

describe('resolveCurrency', () => {
  const { BRL, USD } = CurrencyCode.enum;
  const acc = (currency: typeof BRL | typeof USD) => ({ currency });
  const card = (currency: typeof BRL | typeof USD) => ({ currency });

  it('prefers account currency', () => {
    expect(resolveCurrency(acc(USD), card(BRL), { currency: BRL })).toBe(USD);
  });

  it('falls back to card when no account', () => {
    expect(resolveCurrency(null, card(USD), { currency: BRL })).toBe(USD);
  });

  it('falls back to explicit currency when no account or card', () => {
    expect(resolveCurrency(null, null, { currency: USD })).toBe(USD);
  });

  it('defaults to USD when nothing is provided', () => {
    expect(resolveCurrency(null, null, {})).toBe(USD);
  });
});

describe('guardTransferMutability', () => {
  const transfer = { type: 'transfer' as const };
  const expense = { type: 'expense' as const };

  it('rejects changing type on a transfer', () => {
    const result = guardTransferMutability(transfer, { type: 'expense' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects setting category on a transfer', () => {
    const result = guardTransferMutability(transfer, { category: 'Alimentação' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects setting subCategory on a transfer', () => {
    const result = guardTransferMutability(transfer, { subCategory: 'Restaurante' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('allows non-transfer updates on expense transactions', () => {
    expect(guardTransferMutability(expense, { type: 'income' }).isOk()).toBe(true);
    expect(guardTransferMutability(expense, { category: 'Alimentação' }).isOk()).toBe(true);
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

describe('assertExclusiveAccountCard', () => {
  it('passes when only account is provided', () => {
    expect(assertExclusiveAccountCard({ account: 'A' })).toBe(true);
  });

  it('passes when only card is provided', () => {
    expect(assertExclusiveAccountCard({ card: 'C' })).toBe(true);
  });

  it('passes when neither is provided', () => {
    expect(assertExclusiveAccountCard({})).toBe(true);
  });

  it('fails when both are provided', () => {
    expect(assertExclusiveAccountCard({ account: 'A', card: 'C' })).toBe(false);
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

describe('assertBillPeriodPaired', () => {
  it('passes when neither billMonth nor billYear is provided', () => {
    expect(assertBillPeriodPaired({})).toBe(true);
  });

  it('passes when both are provided', () => {
    expect(assertBillPeriodPaired({ billMonth: 6, billYear: 2026 })).toBe(true);
  });

  it('fails when only billMonth is provided', () => {
    expect(assertBillPeriodPaired({ billMonth: 6 })).toBe(false);
  });

  it('fails when only billYear is provided', () => {
    expect(assertBillPeriodPaired({ billYear: 2026 })).toBe(false);
  });
});

describe('assertBillAssignmentHasCard', () => {
  it('passes when billMonth is not provided, regardless of card', () => {
    expect(assertBillAssignmentHasCard(undefined, false)).toBe(true);
    expect(assertBillAssignmentHasCard(undefined, true)).toBe(true);
  });

  it('passes when billMonth is provided and a card is present', () => {
    expect(assertBillAssignmentHasCard(6, true)).toBe(true);
  });

  it('fails when billMonth is provided but no card is present', () => {
    expect(assertBillAssignmentHasCard(6, false)).toBe(false);
  });

  // billMonth: 0 is out of the schema's valid range (1-12) and never reaches this predicate through
  // the real API — but the check must use explicit undefined, not truthiness, so a 0 is correctly
  // treated as "provided" rather than silently passing as "not provided".
  it('treats billMonth 0 as provided, not as absent', () => {
    expect(assertBillAssignmentHasCard(0, false)).toBe(false);
    expect(assertBillAssignmentHasCard(0, true)).toBe(true);
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
