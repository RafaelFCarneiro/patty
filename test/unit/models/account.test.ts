import { describe, expect, it } from 'vitest';
import {
  AddAccountMovementSchema,
  UpdateAccountTransactionSchema,
  accountErrors,
  CreateAccountSchema,
  UpdateAccountSchema,
} from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';

describe('accountErrors (colocated domain error payloads)', () => {
  it('creditRejected is a validation error mentioning the card flow', () => {
    expect(accountErrors.creditRejected.code).toBe('validation');
    if (accountErrors.creditRejected.code === 'validation') {
      expect(accountErrors.creditRejected.issues[0]).toContain('credit card');
    }
  });

  it('duplicateName carries the entity + name', () => {
    expect(accountErrors.duplicateName('Nubank')).toEqual({
      code: 'duplicate_name',
      entity: 'account',
      name: 'Nubank',
    });
  });

  it('typeImmutable / currencyImmutable* embed the transaction count', () => {
    expect(accountErrors.typeImmutable(3)).toMatchObject({ code: 'validation' });
    expect((accountErrors.typeImmutable(3) as { issues: string[] }).issues[0])
      .toContain('3 transaction');
    expect((accountErrors.currencyImmutableTransactions(2) as { issues: string[] }).issues[0])
      .toContain('2 transaction');
  });
});

describe('account schemas (domain integrity vs. boundary convenience)', () => {
  it('CreateAccountSchema requires currency (integrity, not-null) — no domain default', () => {
    expect(CreateAccountSchema.safeParse({ name: 'A', type: 'checking' }).success).toBe(false);
  });

  it('CreateAccountSchema applies the integrity default for initialBalance', () => {
    const parsed = CreateAccountSchema.parse({ name: 'A', type: 'checking', currency: CurrencyCode.enum.USD });
    expect(parsed.initialBalance).toBe(0);
  });

  it('UpdateAccountSchema makes type/currency/initialBalance optional but keeps name', () => {
    expect(UpdateAccountSchema.safeParse({ name: 'A' }).success).toBe(true);
    expect(UpdateAccountSchema.safeParse({ newName: 'B' }).success).toBe(false);
  });
});

// ADR-019 step 1: AddAccountMovementSchema/UpdateAccountTransactionSchema compose UP from the
// minimal transaction core (`.extend`) rather than the core carrying account/card/bill fields for
// these to `.omit`.
describe('AddAccountMovementSchema / UpdateAccountTransactionSchema — compose up (ADR-019)', () => {
  const base = { description: 'Lunch', amount: 10, idempotencyKey: 'k-1' };

  it('AddAccountMovementSchema accepts an optional account name', () => {
    expect(AddAccountMovementSchema.safeParse({ ...base, account: 'Nubank' }).success).toBe(true);
    expect(AddAccountMovementSchema.safeParse(base).success).toBe(true);
  });

  it('AddAccountMovementSchema rejects card/type/billMonth/billYear — foreign vocabulary (.strict())', () => {
    expect(AddAccountMovementSchema.safeParse({ ...base, card: 'Nubank' }).success).toBe(false);
    expect(AddAccountMovementSchema.safeParse({ ...base, type: 'expense' }).success).toBe(false);
    expect(AddAccountMovementSchema.safeParse({ ...base, billMonth: 6, billYear: 2026 }).success).toBe(false);
  });

  it('UpdateAccountTransactionSchema accepts account (its own context field)', () => {
    expect(UpdateAccountTransactionSchema.safeParse({ id: 'tx-1', account: 'Nubank' }).success).toBe(true);
  });

  it('UpdateAccountTransactionSchema structurally rejects billMonth/billYear (.strict())', () => {
    const result = UpdateAccountTransactionSchema.safeParse({ id: 'tx-1', billMonth: 6, billYear: 2026 });
    expect(result.success).toBe(false);
  });
});
