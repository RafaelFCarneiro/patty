import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { buildBulkResult } from '../../../../src/controllers/transaction/bulk.js';
import { validation } from '../../../../src/models/error.js';
import type { ClassifiedUpsertResult, TransactionView } from '../../../../src/models/transaction.js';

const transaction = (overrides: Partial<TransactionView> = {}): TransactionView => ({
  id: 'tx-1',
  description: 'Coffee',
  amount: 5,
  type: 'expense',
  status: 'effective',
  date: '2026-06-10',
  currency: 'USD',
  source: 'import',
  idempotencyKey: 'k1',
  typeLabel: 'Expense',
  statusLabel: 'Effective',
  tags: [],
  ...overrides,
});

describe('buildBulkResult — shapes per-line SequenceOutcomes into the BulkResult contract', () => {
  it('reports created for a fresh insert and duplicate for a replay, in line order', () => {
    const created: ClassifiedUpsertResult = {
      transaction: transaction({ id: 'tx-created' }),
      created: true,
      classification: { method: 'rule', confidence: 0.9 },
    };
    const duplicate: ClassifiedUpsertResult = { transaction: transaction({ id: 'tx-dup' }), created: false };

    const result = buildBulkResult([ok(created), ok(duplicate)], [{ description: 'Coffee' }, { description: 'Taxi' }]);

    expect(result.summary).toEqual({ created: 1, needsReview: 0, duplicates: 1, errors: 0 });
    expect(result.items[0]).toMatchObject({ status: 'created' });
    expect(result.items[1]).toMatchObject({ status: 'duplicate' });
  });

  it('flags low-confidence classification as needs_review, not created', () => {
    const lowConfidence: ClassifiedUpsertResult = {
      transaction: transaction(),
      created: true,
      classification: { method: 'none', confidence: 0 },
    };

    const result = buildBulkResult([ok(lowConfidence)], [{ description: 'Coffee' }]);

    expect(result.summary).toEqual({ created: 0, needsReview: 1, duplicates: 0, errors: 0 });
    expect(result.items[0]).toMatchObject({ status: 'needs_review' });
  });

  it("carries a failed unit's AppError and description without disturbing sibling outcomes", () => {
    const okItem: ClassifiedUpsertResult = {
      transaction: transaction(),
      created: true,
      classification: { method: 'rule', confidence: 0.9 },
    };

    const result = buildBulkResult(
      [err(validation(['bad line'])), ok(okItem)],
      [{ description: 'Bad line' }, { description: 'Good line' }],
    );

    expect(result.summary).toEqual({ created: 1, needsReview: 0, duplicates: 0, errors: 1 });
    expect(result.items[0]).toEqual({
      status: 'error',
      description: 'Bad line',
      error: validation(['bad line']),
    });
    expect(result.items[1]).toMatchObject({ status: 'created' });
  });
});
