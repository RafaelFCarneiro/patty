import { describe, expect, it } from 'vitest';
import { confirmTransaction } from '../../../../src/controllers/transaction/core.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import type { FlowOutcome, PersistOutcome } from '../../../../src/models/persistable.js';
import { PersistOp } from '../../../../src/models/persistable.js';
import { TransactionStatus, type RawTransactionView } from '../../../../src/models/transaction.js';
import { Locale } from '../../../../src/models/locale.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as unknown as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  ...overrides,
});

/** Resolves a `FlowOutcome`'s `response` against synthesized apply outcomes — mirrors what
 *  `runEffects` does post-commit, without a real database. */
const resolveResponse = <T>(outcome: FlowOutcome<T>, outcomes: PersistOutcome[]): T => {
  const { response } = outcome;
  return typeof response === 'function' ? response(outcomes) : response;
};

const pendingTx: RawTransactionView = {
  id: 'tx-1',
  description: 'Original',
  amount: 10,
  type: 'expense',
  status: 'pending',
  date: '2026-06-15',
  currency: 'USD',
  source: 'mcp',
  idempotencyKey: 'existing-key',
  classification: { method: 'none', confidence: 0 },
  tags: [],
  version: 3,
};

describe('confirmTransaction — flips pending to effective as a functional-core flow', () => {
  it('errors unknown_transaction when the id does not exist', async () => {
    const deps = makeDeps({ transactions: { getById: async () => null } as unknown as Deps['transactions'] });

    const result = await confirmTransaction(deps, { id: 'missing' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'unknown_transaction', id: 'missing' });
  });

  it('is an idempotent no-op (no writes) when already effective', async () => {
    const effectiveTx = { ...pendingTx, status: TransactionStatus.enum.effective };
    const deps = makeDeps({ transactions: { getById: async () => effectiveTx } as unknown as Deps['transactions'] });

    const result = await confirmTransaction(deps, { id: 'tx-1' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toMatchObject({ id: 'tx-1', status: TransactionStatus.enum.effective });
  });

  it('emits a version-guarded update flipping status to effective, preserving every other field', async () => {
    const deps = makeDeps({ transactions: { getById: async () => pendingTx } as unknown as Deps['transactions'] });

    const result = await confirmTransaction(deps, { id: 'tx-1' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: 'transaction',
        model: {
          id: 'tx-1',
          description: pendingTx.description,
          amount: pendingTx.amount,
          type: pendingTx.type,
          status: TransactionStatus.enum.effective,
          date: pendingTx.date,
          currency: pendingTx.currency,
          source: pendingTx.source,
          idempotencyKey: pendingTx.idempotencyKey,
          classification: pendingTx.classification,
          refs: {},
          tagNames: [],
          version: pendingTx.version,
        },
      },
    ]);
  });

  it('response() reflects the shell-applied, joined view once the update commits', async () => {
    const deps = makeDeps({ transactions: { getById: async () => pendingTx } as unknown as Deps['transactions'] });

    const result = await confirmTransaction(deps, { id: 'tx-1' });
    const outcome = result._unsafeUnwrap();

    const persistedView: RawTransactionView = { ...pendingTx, status: TransactionStatus.enum.effective };
    const response = resolveResponse(outcome, [{ entity: 'transaction', applied: true, read: persistedView }]);
    expect(response.status).toBe(TransactionStatus.enum.effective);
    expect(response.id).toBe('tx-1');
  });
});
