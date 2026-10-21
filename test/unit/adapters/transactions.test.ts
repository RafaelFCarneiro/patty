import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../src/models/money.js';
import {
  CreateTransactionSchema,
  NOTE_MAX_LENGTH,
  TransactionSource,
  TransactionStatus,
  UpdateTransactionSchema,
  type Transaction,
} from '../../../src/models/transaction.js';
import { ImportAccountStatementItemSchema } from '../../../src/models/account.js';
import { ImportCardStatementItemSchema } from '../../../src/models/credit-card.js';
import * as wireInTransactions from '../../../src/wire/in/transactions.js';
import * as transactionAdapters from '../../../src/adapters/transactions.js';

const draft: Transaction = {
  id: 'tx-1',
  description: 'Uber para o aeroporto',
  amount: 32.5,
  type: 'expense',
  status: TransactionStatus.enum.effective,
  date: '2026-06-09',
  currency: CurrencyCode.enum.BRL,
  source: TransactionSource.enum.mcp,
  classification: { method: 'rule', confidence: 0.8 },
  rawInput: 'paguei 32,50 de uber',
  refs: { accountId: 'acc-1', categoryId: 'cat-transporte', merchantKey: 'uber' },
};

describe('modelToDb', () => {
  it('flattens classification into node properties', () => {
    const { props } = transactionAdapters.modelToDb(draft);
    expect(props).toMatchObject({
      id: 'tx-1',
      classificationMethod: 'rule',
      confidence: 0.8,
      rawInput: 'paguei 32,50 de uber',
    });
    expect(props).not.toHaveProperty('classification');
    expect(props).not.toHaveProperty('refs');
  });

  it('maps note to db (present → value, absent → null)', () => {
    const { props: withNote } = transactionAdapters.modelToDb({ ...draft, note: 'split com João' });
    expect(withNote.note).toBe('split com João');

    const { props: withoutNote } = transactionAdapters.modelToDb({ ...draft, note: undefined });
    expect(withoutNote.note).toBeNull();
  });

  it('converts missing optionals to explicit nulls for Cypher params', () => {
    const { props, refs } = transactionAdapters.modelToDb({
      ...draft,
      rawInput: undefined,
      refs: { accountId: 'acc-1', toAccountId: 'acc-2' },
    });
    expect(props.rawInput).toBeNull();
    expect(refs).toEqual({
      accountId: 'acc-1',
      toAccountId: 'acc-2',
      cardId: null,
      billId: null,
      categoryId: null,
      subCategoryId: null,
      merchantKey: null,
    });
  });

  it('supports transfer drafts (both account refs, no classification edge data)', () => {
    const { props, refs } = transactionAdapters.modelToDb({
      ...draft,
      type: 'transfer',
      classification: { method: 'none', confidence: 0 },
      refs: { accountId: 'acc-1', toAccountId: 'acc-2' },
    });
    expect(props.type).toBe('transfer');
    expect(props.classificationMethod).toBe('none');
    expect(refs.accountId).toBe('acc-1');
    expect(refs.toAccountId).toBe('acc-2');
  });
});

// Flat SQL row as returned by a full transaction SELECT (with JOINs)
const sqlRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'tx-1',
  description: 'Uber',
  amount: 32.5,
  type: 'expense',
  status: TransactionStatus.enum.effective,
  date: '2026-06-09',
  currency: CurrencyCode.enum.BRL,
  source: TransactionSource.enum.mcp,
  idempotency_key: 'k1',
  classification_method: 'rule',
  confidence: 0.8,
  raw_input: null,
  note: null,
  from_account_id: 'acc-1',
  from_account_name: 'Nubank',
  to_account_id: null,
  to_account_name: null,
  credit_card_id: null,
  credit_card_name: null,
  bill_id: null,
  category_id: null,
  category_name: null,
  subcategory_id: null,
  subcategory_name: null,
  merchant_key: null,
  tags: null,
  version: 0,
  ...overrides,
});

describe('wireIn adapters', () => {
  it('searchWireInToModel applies limit default of 50 when omitted', () => {
    const parsed = wireInTransactions.SearchTransactionsInputSchema.parse({});
    expect(transactionAdapters.searchWireInToModel(parsed)).toMatchObject({ limit: 50 });
  });

  it('searchWireInToModel preserves explicit limit when provided', () => {
    const parsed = wireInTransactions.SearchTransactionsInputSchema.parse({ limit: 10, month: 6, year: 2026 });
    expect(transactionAdapters.searchWireInToModel(parsed)).toMatchObject({ limit: 10, month: 6, year: 2026 });
  });

  // ADR-014: a REST query string never carries a real number — limit must coerce like
  // CoercedPeriodSchema (wire/in/period.js) does for month/year, or `?limit=10` 422s.
  it('SearchTransactionsQuerySchema coerces a string limit from the query string', () => {
    const parsed = wireInTransactions.SearchTransactionsQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });

  it('SearchTransactionsQuerySchema coerces string month/year from the query string', () => {
    const parsed = wireInTransactions.SearchTransactionsQuerySchema.parse({ month: '9', year: '2033' });
    expect(parsed).toMatchObject({ month: 9, year: 2033 });
  });

  it('SearchTransactionsQuerySchema rejects an out-of-range or non-numeric month from the query string', () => {
    const { SearchTransactionsQuerySchema } = wireInTransactions;
    expect(SearchTransactionsQuerySchema.safeParse({ month: '13', year: '2033' }).success).toBe(false);
    expect(SearchTransactionsQuerySchema.safeParse({ month: 'abc', year: '2033' }).success).toBe(false);
  });

  it('searchWireInToModel defaults sort to date, dir to desc, includeTotal to false', () => {
    const parsed = wireInTransactions.SearchTransactionsInputSchema.parse({});
    expect(transactionAdapters.searchWireInToModel(parsed)).toMatchObject({
      sort: 'date',
      dir: 'desc',
      includeTotal: false,
    });
  });

  it('searchWireInToModel preserves explicit sort/dir and parses includeTotal from a query string', () => {
    const parsed = wireInTransactions.SearchTransactionsInputSchema.parse({
      sort: 'amount',
      dir: 'asc',
      includeTotal: 'true',
    });
    expect(transactionAdapters.searchWireInToModel(parsed)).toMatchObject({
      sort: 'amount',
      dir: 'asc',
      includeTotal: true,
    });
  });
});

describe('dbToModel', () => {
  it('nests flat db classification back into the model', () => {
    const tx = transactionAdapters.dbToModel(
      sqlRow({
        category_id: 'cat-transporte',
        category_name: 'Transporte',
        merchant_key: 'uber',
      }),
    );
    expect(tx.classification).toEqual({ method: 'rule', confidence: 0.8 });
    expect(tx.accountName).toBe('Nubank');
    expect(tx.merchant).toBe('uber');
  });

  it('maps null relation columns to undefined optionals', () => {
    const tx = transactionAdapters.dbToModel(
      sqlRow({
        from_account_id: null,
        from_account_name: null,
      }),
    );
    expect(tx.accountId).toBeUndefined();
    expect(tx.toAccountId).toBeUndefined();
    expect(tx.rawInput).toBeUndefined();
    expect(tx.billId).toBeUndefined();
  });

  it('maps bill_id to billId when the transaction belongs to a bill', () => {
    const tx = transactionAdapters.dbToModel(sqlRow({ bill_id: 'bill-1' }));
    expect(tx.billId).toBe('bill-1');
  });

  it('round-trips a transfer with both account sides', () => {
    const tx = transactionAdapters.dbToModel(
      sqlRow({
        type: 'transfer',
        classification_method: 'none',
        confidence: 0,
        to_account_id: 'acc-2',
        to_account_name: 'Poupança',
      }),
    );
    expect(tx.type).toBe('transfer');
    expect(tx.toAccountName).toBe('Poupança');
  });

  it('maps tags from db record to TransactionView', () => {
    const tx = transactionAdapters.dbToModel(sqlRow({ tags: '["work","travel"]' }));
    expect(tx.tags).toEqual(['work', 'travel']);
  });

  it('defaults tags to empty array when absent in db record', () => {
    const tx = transactionAdapters.dbToModel(sqlRow({ tags: null }));
    expect(tx.tags).toEqual([]);
  });

  it('handles explicit empty tags array from db', () => {
    const tx = transactionAdapters.dbToModel(sqlRow({ tags: '[null]' }));
    expect(tx.tags).toEqual([]);
  });

  // Issue: TransactionView.tags used z.string() allowing empty strings from db
  it('rejects empty string tags coming from db', () => {
    expect(() => transactionAdapters.dbToModel(sqlRow({ tags: '[""]' }))).toThrow();
  });

  it('parses category_names JSON into categoryNames map', () => {
    const tx = transactionAdapters.dbToModel(
      sqlRow({
        category_id: 'cat-food',
        category_name: 'Food',
        category_names: '{"pt":"Alimentação","es":"Alimentación"}',
      }),
    );
    expect(tx.categoryNames).toEqual({ pt: 'Alimentação', es: 'Alimentación' });
    expect(tx.categoryName).toBe('Food');
  });

  it('parses subcategory_names JSON into subCategoryNames map', () => {
    const tx = transactionAdapters.dbToModel(
      sqlRow({
        subcategory_id: 'sub-1',
        subcategory_name: 'Groceries',
        subcategory_names: '{"pt":"Supermercado"}',
      }),
    );
    expect(tx.subCategoryNames).toEqual({ pt: 'Supermercado' });
    expect(tx.subCategoryName).toBe('Groceries');
  });

  it('defaults categoryNames and subCategoryNames to null when absent', () => {
    const tx = transactionAdapters.dbToModel(sqlRow());
    expect(tx.categoryNames).toBeNull();
    expect(tx.subCategoryNames).toBeNull();
  });

  it('maps note from db (present → string, null → undefined)', () => {
    const withNote = transactionAdapters.dbToModel(sqlRow({ note: 'reembolsável' }));
    expect(withNote.note).toBe('reembolsável');

    const withoutNote = transactionAdapters.dbToModel(sqlRow({ note: null }));
    expect(withoutNote.note).toBeUndefined();
  });

  it('handles null category_names (user-created categories)', () => {
    const tx = transactionAdapters.dbToModel(
      sqlRow({
        category_id: 'custom-1',
        category_name: 'My Custom',
        category_names: null,
      }),
    );
    expect(tx.categoryNames).toBeNull();
    expect(tx.categoryName).toBe('My Custom');
  });
});

// Unlike the retired god CreateTransactionsBulkSchema's per-line BulkTransactionItemSchema (which
// silently stripped subCategory/tags as unknown keys), the aggregate-specific statement item
// schemas below are `.strict()` — same rationale as AddCardPurchaseSchema/AddAccountMovementSchema
// (models/credit-card.ts, models/account.ts): a caller who mistakenly sends a field that doesn't
// apply to a statement line should get a validation error, not have it silently dropped.
describe('ImportAccountStatementItemSchema', () => {
  it('rejects subCategory and tags on account statement items', () => {
    const result = ImportAccountStatementItemSchema.safeParse({
      description: 'Uber',
      amount: 30,
      type: 'expense',
      subCategory: 'Ride',
      tags: ['work'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts account statement items without subCategory and tags', () => {
    const result = ImportAccountStatementItemSchema.safeParse({
      description: 'Groceries',
      amount: 50,
      type: 'expense',
    });
    expect(result.success).toBe(true);
  });
});

describe('ImportCardStatementItemSchema', () => {
  it('rejects subCategory and tags on card statement items', () => {
    const result = ImportCardStatementItemSchema.safeParse({
      description: 'Uber',
      amount: 30,
      type: 'expense',
      subCategory: 'Ride',
      tags: ['work'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts card statement items without subCategory and tags', () => {
    const result = ImportCardStatementItemSchema.safeParse({
      description: 'Groceries',
      amount: 50,
      type: 'expense',
    });
    expect(result.success).toBe(true);
  });
});

// The transaction core's own CreateTransactionSchema (ADR-016) — note validation is core row
// integrity, inherited unchanged by every aggregate schema derived from it (AddCardPurchaseSchema,
// AddAccountMovementSchema, ImportCardStatementItemSchema, ImportAccountStatementItemSchema), so
// it's tested once here at the source.
describe('note zod validation', () => {
  it('rejects a note longer than NOTE_MAX_LENGTH on create', () => {
    const result = CreateTransactionSchema.safeParse({
      description: 'Test',
      amount: 10,
      type: 'expense',
      idempotencyKey: 'k1',
      note: 'x'.repeat(NOTE_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a note longer than NOTE_MAX_LENGTH on update', () => {
    // UpdateTransactionSchema (models/transaction.ts) is the shared base UpdateCardTransactionSchema/
    // UpdateAccountTransactionSchema derive from (ADR-017) — tested once here at the source, same as
    // CreateTransactionSchema above; no wire/in schema exists for this generic case post-split.
    const result = UpdateTransactionSchema.safeParse({
      id: 'tx-1',
      note: 'x'.repeat(NOTE_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty string note on create', () => {
    const result = CreateTransactionSchema.safeParse({
      description: 'Test',
      amount: 10,
      type: 'expense',
      idempotencyKey: 'k1',
      note: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a note at exactly NOTE_MAX_LENGTH', () => {
    const result = CreateTransactionSchema.safeParse({
      description: 'Test',
      amount: 10,
      type: 'expense',
      idempotencyKey: 'k1',
      note: 'x'.repeat(NOTE_MAX_LENGTH),
    });
    expect(result.success).toBe(true);
  });
});

describe('optional', () => {
  it('turns a nullable column into an optional field, keeping every other value, falsy ones included', () => {
    expect(transactionAdapters.optional(null)).toBeUndefined();
    expect(transactionAdapters.optional(undefined)).toBeUndefined();
    expect(transactionAdapters.optional('note')).toBe('note');
    expect(transactionAdapters.optional('')).toBe('');
    expect(transactionAdapters.optional(0)).toBe(0);
  });
});

describe('parseTags', () => {
  it('reads the tag names out of the JSON array column', () => {
    expect(transactionAdapters.parseTags('["food","trip"]')).toEqual(['food', 'trip']);
  });

  it('is empty for a row with no tags (null) or an empty column', () => {
    expect(transactionAdapters.parseTags(null)).toEqual([]);
    expect(transactionAdapters.parseTags('')).toEqual([]);
    expect(transactionAdapters.parseTags('[]')).toEqual([]);
  });

  it('drops anything that is not a string (json_group_array yields null for a tag-less LEFT JOIN row)', () => {
    expect(transactionAdapters.parseTags('[null,"food",3,{"a":1}]')).toEqual(['food']);
  });

  it('throws on malformed JSON rather than inventing tags', () => {
    expect(() => transactionAdapters.parseTags('[not json')).toThrow(SyntaxError);
  });
});

describe('parseNames', () => {
  it('reads the localized names of a category', () => {
    expect(transactionAdapters.parseNames('{"pt":"Comida","es":"Comida"}')).toEqual({ pt: 'Comida', es: 'Comida' });
  });

  it('is null for a row with no names (a user category, or no category at all)', () => {
    expect(transactionAdapters.parseNames(null)).toBeNull();
    expect(transactionAdapters.parseNames('null')).toBeNull();
  });

  it('throws on malformed JSON, and on names that are not a map of non-empty strings', () => {
    expect(() => transactionAdapters.parseNames('{oops')).toThrow(SyntaxError);
    expect(() => transactionAdapters.parseNames('{"pt":""}')).toThrow();
    expect(() => transactionAdapters.parseNames('["pt"]')).toThrow();
  });
});
