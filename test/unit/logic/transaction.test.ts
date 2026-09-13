import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';
import { CURSOR_VERSION, encodeCursor, SortDirection } from '../../../src/models/page.js';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
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
  buildTransactionView,
  buildUpsertResult,
  defaultStatementLines,
  deriveIdempotencyKey,
  entityFromExisting,
  hasCategory,
  hasSubCategory,
  isCategoryKindAllowed,
  isTransfer,
  needsReview,
  nextCursorAfter,
  resolveCursorKey,
  resolveEffectiveType,
  summarizeBulkItems,
} from '../../../src/logic/transaction.js';

describe('deriveIdempotencyKey', () => {
  const identity = (overrides: Partial<Parameters<typeof deriveIdempotencyKey>[0]> = {}) => ({
    fundingSourceId: 'acct-1',
    type: TransactionType.enum.expense,
    currency: CurrencyCode.enum.BRL,
    date: '2026-06-09',
    description: 'PAG*UberTrip 99-SP',
    amount: 32.5,
    ...overrides,
  });

  it('is a 64-char hex sha256 digest, stable for the same identity', () => {
    expect(deriveIdempotencyKey(identity(), 2)).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveIdempotencyKey(identity(), 2)).toBe(deriveIdempotencyKey(identity(), 2));
  });

  it('differs when amount differs', () => {
    expect(deriveIdempotencyKey(identity({ amount: 30 }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ amount: 31 }), 2),
    );
  });

  it('rounds the amount to the given decimals, colliding values differing only past it (regression)', () => {
    expect(deriveIdempotencyKey(identity({ amount: 5.999 }), 2)).toBe(deriveIdempotencyKey(identity({ amount: 6 }), 2));
  });

  it('gives DISTINCT keys for two amounts differing only past the 2nd decimal when decimals is 8 (BTC)', () => {
    const a = identity({ amount: 0.12345671, currency: CurrencyCode.enum.BTC });
    const b = identity({ amount: 0.12345679, currency: CurrencyCode.enum.BTC });
    expect(deriveIdempotencyKey(a, 8)).not.toBe(deriveIdempotencyKey(b, 8));
  });

  it('gives IDENTICAL keys for identical amounts at 8 decimals (BTC)', () => {
    const item = identity({ amount: 0.12345678, currency: CurrencyCode.enum.BTC });
    expect(deriveIdempotencyKey(item, 8)).toBe(deriveIdempotencyKey({ ...item }, 8));
  });

  it('differs across funding source — two accounts with an otherwise-identical line no longer collide', () => {
    expect(deriveIdempotencyKey(identity({ fundingSourceId: 'acct-1' }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ fundingSourceId: 'acct-2' }), 2),
    );
  });

  it('treats an unattached (undefined fundingSourceId) movement as its own distinct group', () => {
    expect(deriveIdempotencyKey(identity({ fundingSourceId: undefined }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ fundingSourceId: 'acct-1' }), 2),
    );
  });

  it('differs across type', () => {
    expect(deriveIdempotencyKey(identity({ type: TransactionType.enum.expense }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ type: TransactionType.enum.income }), 2),
    );
  });

  it('differs across currency', () => {
    expect(deriveIdempotencyKey(identity({ currency: CurrencyCode.enum.BRL }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ currency: CurrencyCode.enum.USD }), 2),
    );
  });

  it('differs when a discriminator is supplied — the escape hatch for a genuinely-distinct transaction', () => {
    expect(deriveIdempotencyKey(identity(), 2)).not.toBe(deriveIdempotencyKey(identity(), 2, 'second'));
  });

  it('is stable for the same discriminator', () => {
    expect(deriveIdempotencyKey(identity(), 2, 'second')).toBe(deriveIdempotencyKey(identity(), 2, 'second'));
  });

  it('differs across counterpartyId — two transfers to different destinations no longer collide', () => {
    expect(deriveIdempotencyKey(identity({ counterpartyId: 'acct-to-1' }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ counterpartyId: 'acct-to-2' }), 2),
    );
  });

  it('treats an absent counterpartyId (non-transfer) as its own distinct group from any set one', () => {
    expect(deriveIdempotencyKey(identity({ counterpartyId: undefined }), 2)).not.toBe(
      deriveIdempotencyKey(identity({ counterpartyId: 'acct-to-1' }), 2),
    );
  });

  it('rounds via roundToDecimals, not raw toFixed — a float rounding boundary hashes under the real amount', () => {
    // 1.005 is not exactly representable in binary float; Number.prototype.toFixed(2) truncates it
    // to "1.00", while roundToDecimals (EPSILON-corrected, logic/money.ts) correctly rounds it up
    // to 1.01. The derived key must agree with the latter, or a distinct insert at this exact
    // boundary could be silently dropped as a false duplicate of a genuinely different amount.
    const boundary = identity({ amount: 1.005 });
    expect(deriveIdempotencyKey(boundary, 2)).toBe(deriveIdempotencyKey(identity({ amount: 1.01 }), 2));
    expect(deriveIdempotencyKey(boundary, 2)).not.toBe(deriveIdempotencyKey(identity({ amount: 1.0 }), 2));
  });

  it('does not collide when a word boundary shifts between description and discriminator (regression)', () => {
    // A plain space-joined canonical string would be ambiguous here: description:'a'+discriminator:'b c'
    // and description:'a b'+discriminator:'c' could concatenate to related-looking strings. The
    // JSON-array canonical encoding (quoted, comma-separated elements) keeps every field boundary
    // unambiguous regardless of what characters a field (especially the caller-supplied
    // discriminator, which is otherwise unconstrained) contains.
    const a = deriveIdempotencyKey(identity({ description: 'a' }), 2, 'b c');
    const b = deriveIdempotencyKey(identity({ description: 'a b' }), 2, 'c');
    expect(a).not.toBe(b);
  });
});

describe('defaultStatementLines — pure per-line defaulting', () => {
  it('defaults date to the caller-resolved today when absent', () => {
    const line = defaultStatementLines('2026-06-10', [{ description: 'Coffee', amount: 5 }], undefined)[0]!;

    expect(line.date).toBe('2026-06-10');
    expect(line.rawInput).toBeUndefined();
  });

  it('never overrides an explicit date', () => {
    const line = defaultStatementLines(
      '2026-06-10',
      [{ description: 'Coffee', amount: 5, date: '2026-01-01' }],
      undefined,
    )[0]!;

    expect(line.date).toBe('2026-01-01');
  });

  it("stamps the whole import's rawInput onto every line", () => {
    const lines = defaultStatementLines(
      '2026-06-10',
      [
        { description: 'Coffee', amount: 5 },
        { description: 'Taxi', amount: 12 },
      ],
      'pasted statement text',
    );

    expect(lines.map((l) => l.rawInput)).toEqual(['pasted statement text', 'pasted statement text']);
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

describe('isTransfer', () => {
  it('is true for a transfer', () => {
    expect(isTransfer({ type: 'transfer' })).toBe(true);
  });

  it('is false for an expense/income movement', () => {
    expect(isTransfer({ type: 'expense' })).toBe(false);
    expect(isTransfer({ type: 'income' })).toBe(false);
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
  version: 0,
};

describe('addLocalizedLabels', () => {
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
    expect(Object.prototype.hasOwnProperty.call(labeled, 'categoryNames')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(labeled, 'subCategoryNames')).toBe(false);
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
    expect(Object.prototype.hasOwnProperty.call(labeled, 'categoryNames')).toBe(false);
  });
});

describe('entityFromExisting — RawTransactionView → TransactionEntity (Design 014 phase B)', () => {
  it('maps every field confirmTransaction builds its update entity on top of', () => {
    const tx: RawTransactionView = {
      ...baseTx,
      accountId: 'acc-1',
      toAccountId: 'acc-2',
      cardId: 'card-1',
      billId: 'bill-1',
      categoryId: 'cat-food',
      subCategoryId: 'subcat-1',
      merchant: 'merchant-key',
      rawInput: 'coffee 10 bucks',
      note: 'a note',
    };

    expect(entityFromExisting(tx)).toEqual({
      id: tx.id,
      description: tx.description,
      amount: tx.amount,
      type: tx.type,
      status: tx.status,
      date: tx.date,
      currency: tx.currency,
      source: tx.source,
      classification: tx.classification,
      rawInput: tx.rawInput,
      note: tx.note,
      refs: {
        accountId: 'acc-1',
        toAccountId: 'acc-2',
        cardId: 'card-1',
        billId: 'bill-1',
        categoryId: 'cat-food',
        subCategoryId: 'subcat-1',
        merchantKey: 'merchant-key',
      },
    });
  });

  it('drops version, tags, idempotencyKey, and localized-label/name fields — not part of TransactionEntity', () => {
    const entity = entityFromExisting(baseTx);
    expect(entity).not.toHaveProperty('version');
    expect(entity).not.toHaveProperty('tags');
    expect(entity).not.toHaveProperty('idempotencyKey');
  });
});

describe('buildUpsertResult (ADR-021 rule 6)', () => {
  it('reports created:true and the localized view when the shell actually inserted the row (no classification)', () => {
    const view = { ...baseTx, description: 'Groceries' };
    const result = buildUpsertResult(
      [{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }],
      undefined,
      Locale.enum.en,
    );

    expect(result.created).toBe(true);
    expect(result.transaction.description).toBe('Groceries');
    expect(result.classification).toBeUndefined();
  });

  it("reports created:false and the EXISTING row's data on an idempotent duplicate replay", () => {
    const existing = { ...baseTx, description: 'Original replay target' };
    const result = buildUpsertResult(
      [{ entity: TRANSACTION_ENTITY_TAG, applied: false, read: existing }],
      undefined,
      Locale.enum.en,
    );

    expect(result.created).toBe(false);
    expect(result.transaction.description).toBe('Original replay target');
  });

  it('includes classification when a create-shaped flow (e.g. add_account_expense) supplies one', () => {
    const classification = { method: ClassificationMethod.enum.rule, confidence: 0.8 } as const;
    const view = { ...baseTx, description: 'Groceries' };
    const result = buildUpsertResult(
      [{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }],
      classification,
      Locale.enum.en,
    );

    expect(result).toEqual({
      transaction: addLocalizedLabels(view, Locale.enum.en),
      created: true,
      classification,
    });
  });

  it('curries data-last (no classification) into the shape create_transfer hands the shell', () => {
    const view = { ...baseTx, description: 'Transfer' };
    const response = buildUpsertResult(undefined, Locale.enum.en);

    expect(typeof response).toBe('function');
    expect(response([{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }])).toEqual(
      buildUpsertResult([{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }], undefined, Locale.enum.en),
    );
  });

  it('curries data-last (with classification) into the shape add_account_expense hands the shell', () => {
    const classification = { method: ClassificationMethod.enum.rule, confidence: 0.8 } as const;
    const view = { ...baseTx, description: 'Groceries' };
    const response = buildUpsertResult(classification, Locale.enum.en);

    expect(response([{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }])).toEqual(
      buildUpsertResult(
        [{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }],
        classification,
        Locale.enum.en,
      ),
    );
  });
});

describe('buildTransactionView (ADR-021 rule 6)', () => {
  it('returns the localized view of the row the shell actually wrote — no created/classification envelope', () => {
    const view = { ...baseTx, description: 'Updated' };
    const result = buildTransactionView(
      [{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }],
      Locale.enum.pt,
    );

    expect(result.description).toBe('Updated');
    expect(result.typeLabel).toBe('Despesa');
    expect(result).not.toHaveProperty('created');
  });

  it('curries data-last into exactly the FlowOutcome.response shape a flow hands the shell', () => {
    const view = { ...baseTx, description: 'Updated' };
    const response = buildTransactionView(Locale.enum.pt);

    expect(response([{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }])).toEqual(
      buildTransactionView([{ entity: TRANSACTION_ENTITY_TAG, applied: true, read: view }], Locale.enum.pt),
    );
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
