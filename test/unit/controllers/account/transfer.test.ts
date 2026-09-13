import { describe, expect, it, vi } from 'vitest';
import { createTransfer } from '../../../../src/controllers/account/transfer.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import type { FlowOutcome, PersistOutcome } from '../../../../src/models/persistable.js';
import { PersistOp } from '../../../../src/models/persistable.js';
import { TransactionSource, type RawTransactionView } from '../../../../src/models/transaction.js';
import { Locale } from '../../../../src/models/locale.js';
import { SEEDED_CURRENCIES } from '../../fixtures/currencies.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { list: async () => [] } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  // deriveIdempotencyKey needs the resolved currency's decimals (ADR-029 Phase 2b).
  currencies: { list: async () => SEEDED_CURRENCIES } as unknown as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as unknown as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'transfer-id',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  ...overrides,
});

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  name: 'Checking',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
  ...overrides,
});

/** Deliberately sync, matching `FlowOutcome.response`'s own (sync-only) contract and
 *  `effects.ts`'s real `resolveResponse` — `runEffects` never awaits it, so a test helper
 *  that did would mask a flow accidentally returning an async response instead of failing on it. */
const resolveResponse = <T>(outcome: FlowOutcome<T>, outcomes: PersistOutcome[]): T => {
  const { response } = outcome;
  return typeof response === 'function' ? (response as (outcomes: PersistOutcome[]) => T)(outcomes) : response;
};

type MinimalEntity = { id: string; description: string; amount: number; currency: string };
const rawViewFor = (entity: MinimalEntity): RawTransactionView =>
  ({
    id: entity.id,
    description: entity.description,
    amount: entity.amount,
    type: 'transfer',
    status: 'effective',
    date: '2026-06-01',
    currency: entity.currency,
    source: 'mcp',
    idempotencyKey: 'k',
    classification: { method: 'none', confidence: 0 },
    tags: [],
    version: 0,
  }) as RawTransactionView;

const from = account({ id: 'acc-from', name: 'Checking' });
const to = account({ id: 'acc-to', name: 'Savings' });
const otherTo = account({ id: 'acc-other-to', name: 'Investments' });

describe('createTransfer — validation', () => {
  it('rejects transferring from a credit account', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [{ ...from, type: AccountType.enum.credit }, to] } as unknown as Deps['accounts'],
    });

    const result = await createTransfer(deps, { from: from.name, to: to.name, amount: 10 }, TransactionSource.enum.mcp);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a cross-currency transfer', async () => {
    const deps = makeDeps({
      accounts: {
        list: async () => [from, { ...to, currency: CurrencyCode.enum.USD }],
      } as unknown as Deps['accounts'],
    });

    const result = await createTransfer(deps, { from: from.name, to: to.name, amount: 10 }, TransactionSource.enum.mcp);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('createTransfer — the write is returned as data, not performed (ADR-021)', () => {
  it('returns a single insert Persistable for a transfer transaction between the resolved accounts', async () => {
    const deps = makeDeps({ accounts: { list: async () => [from, to] } as unknown as Deps['accounts'] });

    const result = await createTransfer(deps, { from: from.name, to: to.name, amount: 25 }, TransactionSource.enum.mcp);

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toHaveLength(1);
    const persisted = outcome.persist[0] as {
      op: string;
      idempotencyKey?: string;
      model: { type: string; amount: number; currency: string; refs: { accountId: string; toAccountId: string } };
    };
    expect(persisted.op).toBe(PersistOp.enum.insert);
    // Domain-derived (ADR-029 Phase 2b) — a sha256 hex digest, never a caller-supplied value.
    expect(persisted.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.model).not.toHaveProperty('idempotencyKey');
    expect(persisted.model).toMatchObject({
      type: 'transfer',
      amount: 25,
      currency: from.currency,
      refs: { accountId: from.id, toAccountId: to.id },
    });
  });

  it('derives a stable key for an identical repeat, and a different one when discriminator is supplied', async () => {
    const deps = makeDeps({ accounts: { list: async () => [from, to] } as unknown as Deps['accounts'] });
    const input = { from: from.name, to: to.name, amount: 25, date: '2026-06-01', description: 'aporte mensal' };

    const first = await createTransfer(deps, input, TransactionSource.enum.mcp);
    const second = await createTransfer(deps, input, TransactionSource.enum.mcp);
    const third = await createTransfer(deps, { ...input, discriminator: 'second-one' }, TransactionSource.enum.mcp);
    const keyOf = (r: typeof first) => (r._unsafeUnwrap().persist[0] as { idempotencyKey: string }).idempotencyKey;

    expect(keyOf(first)).toBe(keyOf(second));
    expect(keyOf(first)).not.toBe(keyOf(third));
  });

  it('derives a DIFFERENT key for two otherwise-identical transfers to different destinations', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [from, to, otherTo] } as unknown as Deps['accounts'],
    });
    const shared = { from: from.name, amount: 25, date: '2026-06-01', description: 'aporte mensal' };

    const toSavings = await createTransfer(deps, { ...shared, to: to.name }, TransactionSource.enum.mcp);
    const toInvestments = await createTransfer(deps, { ...shared, to: otherTo.name }, TransactionSource.enum.mcp);
    const keyOf = (r: typeof toSavings) => (r._unsafeUnwrap().persist[0] as { idempotencyKey: string }).idempotencyKey;

    expect(keyOf(toSavings)).not.toBe(keyOf(toInvestments));
  });

  it('response() reports created:true when the shell actually inserted the transfer', async () => {
    const deps = makeDeps({ accounts: { list: async () => [from, to] } as unknown as Deps['accounts'] });

    const result = await createTransfer(deps, { from: from.name, to: to.name, amount: 25 }, TransactionSource.enum.mcp);
    const outcome = result._unsafeUnwrap();
    const { model: entity } = outcome.persist[0] as { model: MinimalEntity };

    const response = resolveResponse(outcome, [{ entity: 'transaction', applied: true, read: rawViewFor(entity) }]);
    expect(response.created).toBe(true);
    expect(response.transaction.amount).toBe(25);
  });

  it('response() reports created:false and the EXISTING data on an idempotent duplicate replay', async () => {
    const deps = makeDeps({ accounts: { list: async () => [from, to] } as unknown as Deps['accounts'] });

    const result = await createTransfer(deps, { from: from.name, to: to.name, amount: 25 }, TransactionSource.enum.mcp);
    const outcome = result._unsafeUnwrap();
    const existing = rawViewFor({
      id: 'existing-transfer',
      description: 'Original transfer',
      amount: 99,
      currency: 'BRL',
    });

    const response = resolveResponse(outcome, [{ entity: 'transaction', applied: false, read: existing }]);
    expect(response.created).toBe(false);
    expect(response.transaction.amount).toBe(99);
  });
});
