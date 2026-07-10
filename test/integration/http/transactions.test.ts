import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('POST /api/accounts/expenses', () => {
  it('creates an expense (201)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Coffee', amount: 5.5, date: '2026-06-01', idempotencyKey: 'test-coffee-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('transaction');
    expect(res.json()).toHaveProperty('created', true);
  });

  it('returns 200 on idempotent duplicate', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Dupe', amount: 10, date: '2026-06-01', idempotencyKey: 'dedup-key-1' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Dupe', amount: 10, date: '2026-06-01', idempotencyKey: 'dedup-key-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('created', false);
  });

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/accounts/expenses', payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it('rejects expense with income-only category (422)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Bad cat', amount: 100, category: 'Salary', idempotencyKey: 'kind-mismatch-1' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('category_kind_mismatch');
    expect(res.json().error.hint).toContain('record this as income instead');
  });

  it('rejects category + subCategory together (422)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Ambig',
        amount: 10,
        category: 'Food',
        subCategory: 'something',
        idempotencyKey: 'both-cat-sub',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an explicitly empty category (422) — REST also enforces CategoryFieldsSchema.min(1)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Empty category', amount: 10, category: '', idempotencyKey: 'empty-category' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an explicitly empty subCategory (422)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Empty subCategory', amount: 10, subCategory: '', idempotencyKey: 'empty-subcategory' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('creates with subCategory → sets parent category', async () => {
    const catRes = await inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Sub Tx Parent', kind: 'expense' },
    });
    const parentId = catRes.json().id;
    await inject({ method: 'POST', url: '/api/sub-categories', payload: { name: 'Sub Tx Child', parentId } });
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'With sub', amount: 30, subCategory: 'Sub Tx Child', idempotencyKey: 'sub-tx-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.categoryId).toBe(parentId);
    expect(res.json().transaction.subCategoryName).toBe('Sub Tx Child');
  });

  it('creates with tags and returns them', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'work-tag' } });
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'travel-tag' } });
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Tagged',
        amount: 10,
        date: '2026-06-01',
        idempotencyKey: 'tagged-1',
        tags: ['work-tag', 'travel-tag'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.tags).toContain('work-tag');
    expect(res.json().transaction.tags).toContain('travel-tag');
  });

  it('without tags returns tags: []', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'No tags', amount: 5, date: '2026-06-01', idempotencyKey: 'no-tags-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.tags).toEqual([]);
  });

  it('silently ignores non-existent tag names', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Ghost tag',
        amount: 5,
        date: '2026-06-01',
        idempotencyKey: 'ghost-tag-1',
        tags: ['does-not-exist'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.tags).toEqual([]);
  });

  it('note round-trips via create', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'With note',
        amount: 10,
        date: '2026-06-01',
        idempotencyKey: 'note-1',
        note: 'warranty until 2027',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.note).toBe('warranty until 2027');
  });

  it('date-aware default: future → pending, past → effective', async () => {
    const future = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Future', amount: 50, date: '2099-01-01', idempotencyKey: 'future-default' },
    });
    expect(future.json().transaction.status).toBe('pending');
    const past = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Past', amount: 50, date: '2020-01-01', idempotencyKey: 'past-default' },
    });
    expect(past.json().transaction.status).toBe('effective');
  });

  it('rejects posting to a credit account directly (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Direct Post Payer', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: {
        name: 'Direct Post Card',
        closingDay: 10,
        dueDay: 20,
        currency: 'USD',
        paymentAccount: 'Direct Post Payer',
      },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Bad post',
        amount: 50,
        date: '2026-06-01',
        account: 'Card: Direct Post Card',
        idempotencyKey: 'direct-credit-post',
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/accounts/income', () => {
  it('rejects income with expense-only category (422)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts/income',
      payload: { description: 'Bad cat', amount: 5000, category: 'Food', idempotencyKey: 'kind-mismatch-2' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('category_kind_mismatch');
  });
});

describe('POST /api/transactions/bulk', () => {
  it('creates bulk transactions (201) with per-item results', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/transactions/bulk',
      payload: {
        items: [
          { description: 'Bulk 1', amount: 10, type: 'expense', date: '2026-06-01' },
          { description: 'Bulk 2', amount: 20, type: 'income', date: '2026-06-02' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('items');
    expect(res.json().items).toHaveLength(2);
    expect(res.json()).toHaveProperty('summary');
  });

  it('re-imports are treated as duplicates', async () => {
    const items = [
      { description: 'Bulk Dup', amount: 10, type: 'expense', date: '2026-06-01', idempotencyKey: 'bulk-dup-1' },
    ];
    await inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items } });
    const res = await inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items } });
    expect(res.statusCode).toBe(201);
    expect(res.json().items[0].status).toBe('duplicate');
  });

  it('persists note per item', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/transactions/bulk',
      payload: {
        items: [{ description: 'Bulk Note', amount: 10, type: 'expense', date: '2026-06-01', note: 'bulk memo' }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().items[0].transaction.note).toBe('bulk memo');
  });

  it('rejects empty items (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/transactions/bulk', payload: { items: [] } });
    expect(res.statusCode).toBe(422);
  });

  // The retired unified POST /api/transactions used to reject a body resolving both account and
  // card (422) directly. add_account_expense/add_account_income and the card-purchase route are
  // now single-purpose (no `card` field on the former, no `account` field on the latter), so that
  // exclusivity case is impossible-by-construction there — it survives here, since a bulk item's
  // schema still carries both optional fields and can resolve both via top-level defaults.
  it('rejects a bulk line resolving both account and card via top-level defaults (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Bulk Exclusive Bank', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Bulk Exclusive Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/transactions/bulk',
      payload: {
        account: 'Bulk Exclusive Bank',
        items: [
          {
            description: 'Bulk exclusive line',
            amount: 10,
            type: 'expense',
            date: '2026-06-01',
            card: 'Bulk Exclusive Card',
            idempotencyKey: 'bulk-exclusive-rest',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().items[0].status).toBe('error');
    expect(res.json().items[0].error).toContain('validation');
  });
});

describe('PATCH /api/transactions/:id', () => {
  it('updates a transaction', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Updatable', amount: 7, date: '2026-06-01', idempotencyKey: 'upd-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { description: 'Updated' } });
    expect(res.statusCode).toBe(200);
  });

  it('replaces the tag set', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'tag-a' } });
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'tag-b' } });
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Tag upd',
        amount: 5,
        date: '2026-06-01',
        idempotencyKey: 'tag-upd-1',
        tags: ['tag-a'],
      },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { tags: ['tag-b'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toContain('tag-b');
    expect(res.json().tags).not.toContain('tag-a');
  });

  it('empty tags removes all', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'clear-tag' } });
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Clear tags',
        amount: 3,
        date: '2026-06-01',
        idempotencyKey: 'clear-tags-1',
        tags: ['clear-tag'],
      },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { tags: [] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([]);
  });

  it('note: set, clear, leave unchanged', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Note upd', amount: 5, date: '2026-06-01', idempotencyKey: 'note-upd-1' },
    });
    const id = createRes.json().transaction.id;
    const set = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { note: 'added' } });
    expect(set.json().note).toBe('added');
    const clear = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { note: '' } });
    expect(clear.json().note).toBeUndefined();
    const unchanged = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { amount: 10 } });
    expect(unchanged.json().note).toBeUndefined();
  });

  it('clears sub-category when switching to a plain category', async () => {
    const catRes = await inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Clear Sub Parent', kind: 'expense' },
    });
    await inject({
      method: 'POST',
      url: '/api/sub-categories',
      payload: { name: 'Clear Sub', parentId: catRes.json().id },
    });
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Sub clear', amount: 15, subCategory: 'Clear Sub', idempotencyKey: 'clear-sub-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { category: 'Transport' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().categoryName).toBe('Transport');
    expect(res.json().subCategoryId).toBeUndefined();
  });

  it('preserves sub-category when neither category nor subCategory provided', async () => {
    const catRes = await inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Keep Sub Parent', kind: 'expense' },
    });
    await inject({
      method: 'POST',
      url: '/api/sub-categories',
      payload: { name: 'Keep Sub', parentId: catRes.json().id },
    });
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Keep', amount: 15, subCategory: 'Keep Sub', idempotencyKey: 'keep-sub-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { amount: 20 } });
    expect(res.json().subCategoryName).toBe('Keep Sub');
  });

  it('rejects category on a transfer (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Xfer Cat Src', type: 'checking', currency: 'USD', initialBalance: 500 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Xfer Cat Dst', type: 'savings', currency: 'USD', initialBalance: 0 },
    });
    const xferRes = await inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { from: 'Xfer Cat Src', to: 'Xfer Cat Dst', amount: 50, idempotencyKey: 'xfer-cat-1' },
    });
    const id = xferRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { category: 'Food' } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects changing type of a transfer (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Xfer Type Src', type: 'checking', currency: 'USD', initialBalance: 500 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Xfer Type Dst', type: 'savings', currency: 'USD', initialBalance: 0 },
    });
    const xferRes = await inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { from: 'Xfer Type Src', to: 'Xfer Type Dst', amount: 50, idempotencyKey: 'xfer-type-1' },
    });
    const id = xferRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { type: 'expense' } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects kind mismatch on category change (422)', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Exp', amount: 50, idempotencyKey: 'kind-upd-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { category: 'Salary' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('category_kind_mismatch');
  });

  it('rejects type: transfer at wire boundary (422)', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Wire type', amount: 20, idempotencyKey: 'wire-type-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload: { type: 'transfer' } });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for unknown transaction', async () => {
    const res = await inject({
      method: 'PATCH',
      url: '/api/transactions/00000000-0000-0000-0000-000000000000',
      payload: { description: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/transactions/:id/confirm', () => {
  it('confirms a pending transaction', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Pending', amount: 5, date: '2099-01-01', idempotencyKey: 'pend-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'POST', url: `/api/transactions/${id}/confirm` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('effective');
  });

  it('re-confirming is a no-op', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Reconfirm', amount: 5, date: '2099-01-01', idempotencyKey: 'reconfirm-1' },
    });
    const id = createRes.json().transaction.id;
    await inject({ method: 'POST', url: `/api/transactions/${id}/confirm` });
    const res = await inject({ method: 'POST', url: `/api/transactions/${id}/confirm` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('effective');
  });

  it('returns 404 for unknown transaction', async () => {
    const res = await inject({ method: 'POST', url: '/api/transactions/00000000-0000-0000-0000-000000000000/confirm' });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/transactions/:id', () => {
  it('dry-run by default', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Del Target', amount: 3, date: '2026-06-01', idempotencyKey: 'del-1' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'DELETE', url: `/api/transactions/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('dryRun', true);
  });

  it('deletes with confirm=true', async () => {
    const createRes = await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Del Confirm', amount: 3, date: '2026-06-01', idempotencyKey: 'del-2' },
    });
    const id = createRes.json().transaction.id;
    const res = await inject({ method: 'DELETE', url: `/api/transactions/${id}?confirm=true` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', true);
  });

  it('returns 404 for unknown transaction', async () => {
    const res = await inject({
      method: 'DELETE',
      url: '/api/transactions/00000000-0000-0000-0000-000000000000?confirm=true',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/transactions', () => {
  it('searches transactions by date range', async () => {
    const res = await inject({ method: 'GET', url: '/api/transactions?from=2026-06-01&to=2026-06-30' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('filters by status', async () => {
    const res = await inject({ method: 'GET', url: '/api/transactions?status=pending&from=2099-01-01&to=2099-12-31' });
    expect(res.statusCode).toBe(200);
    const { items: txs } = res.json() as { items: Array<{ status: string }> };
    expect(txs.every((t) => t.status === 'pending')).toBe(true);
  });

  it('filters by tag', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'search-filter-tag' } });
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'search-filter-tag2' } });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Tagged search',
        amount: 7,
        date: '2026-06-10',
        idempotencyKey: 'tag-search-1',
        tags: ['search-filter-tag', 'search-filter-tag2'],
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'Untagged search', amount: 8, date: '2026-06-10', idempotencyKey: 'tag-search-2' },
    });
    const res = await inject({
      method: 'GET',
      url: '/api/transactions?tags=search-filter-tag&tags=search-filter-tag2&from=2026-06-10&to=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    const { items: txs } = res.json() as { items: Array<{ description: string }> };
    expect(txs.some((t) => t.description === 'Tagged search')).toBe(true);
    expect(txs.some((t) => t.description === 'Untagged search')).toBe(false);
  });

  it('returns full tag set (not just filter tag)', async () => {
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'full-set-a' } });
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'full-set-b' } });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Full set',
        amount: 5,
        date: '2026-06-11',
        idempotencyKey: 'full-set-1',
        tags: ['full-set-a', 'full-set-b'],
      },
    });
    const res = await inject({ method: 'GET', url: '/api/transactions?from=2026-06-11&to=2026-06-30' });
    expect(res.statusCode).toBe(200);
    const { items: txs } = res.json() as { items: Array<{ description: string; tags: string[] }> };
    const match = txs.find((t) => t.description === 'Full set');
    expect(match).toBeDefined();
    expect(match!.tags).toContain('full-set-a');
    expect(match!.tags).toContain('full-set-b');
  });

  it('filters by subCategory', async () => {
    const catRes = await inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'SearchSubParent', kind: 'expense' },
    });
    await inject({
      method: 'POST',
      url: '/api/sub-categories',
      payload: { name: 'SearchSub', parentId: catRes.json().id },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'With sub filter',
        amount: 20,
        date: '2026-06-12',
        subCategory: 'SearchSub',
        idempotencyKey: 'search-sub-1',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: { description: 'No sub filter', amount: 20, date: '2026-06-12', idempotencyKey: 'search-sub-2' },
    });
    const res = await inject({
      method: 'GET',
      url: '/api/transactions?subCategory=SearchSub&from=2026-06-01&to=2026-06-30',
    });
    expect(res.statusCode).toBe(200);
    const { items: txs } = res.json() as { items: Array<{ subCategoryName?: string; description?: string }> };
    const filtered = txs.filter((t) => t.subCategoryName === 'SearchSub');
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered[0].description).toBe('With sub filter');
  });

  it('rejects invalid date (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/transactions?from=bad' });
    expect(res.statusCode).toBe(422);
  });

  it('paginates via cursor with no gaps or duplicates (ADR-014)', async () => {
    for (let i = 0; i < 5; i++) {
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: `REST pager ${i}`,
          amount: 1,
          date: '2032-01-15',
          idempotencyKey: `rest-pager-${i}`,
        },
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const url =
        '/api/transactions?from=2032-01-15&to=2032-01-16&limit=2' +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const page = res.json() as { items: Array<{ id: string }>; nextCursor?: string };
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a cursor whose sort/dir does not match the request (422)', async () => {
    // Seeds its own 2 rows, scoped by date range, so nextCursor is guaranteed rather than
    // depending on incidental leftovers from earlier tests in this file.
    for (let i = 0; i < 2; i++) {
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: `REST sort mismatch ${i}`,
          amount: 1,
          date: '2032-02-01',
          idempotencyKey: `rest-sort-mismatch-${i}`,
        },
      });
    }

    const first = await inject({
      method: 'GET',
      url: '/api/transactions?from=2032-02-01&to=2032-02-02&limit=1&sort=date&dir=desc',
    });
    const { nextCursor } = first.json() as { nextCursor?: string };
    expect(nextCursor).toBeDefined();
    const res = await inject({
      method: 'GET',
      url: `/api/transactions?from=2032-02-01&to=2032-02-02&limit=1&sort=amount&dir=desc&cursor=${encodeURIComponent(nextCursor!)}`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation');
  });
});
