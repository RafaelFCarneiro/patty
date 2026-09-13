import { describe, expect, it } from 'vitest';
import {
  ConfirmTransactionSchema,
  CreateTransactionSchema,
  TransactionSchema,
  TransactionViewSchema,
  transactionErrors,
  UpdateTransactionSchema,
} from '../../../src/models/transaction.js';

describe('TransactionSchema — idempotencyKey lives on the envelope, not the domain entity (ADR-029 phase 2)', () => {
  it('TransactionSchema (the domain entity) no longer carries idempotencyKey', () => {
    expect(Object.keys(TransactionSchema.shape)).not.toContain('idempotencyKey');
  });

  it('TransactionViewSchema (wire/out) still carries idempotencyKey — reflects the stored column, out of scope', () => {
    expect(Object.keys(TransactionViewSchema.shape)).toContain('idempotencyKey');
  });
});

describe('CreateTransactionSchema — domain-owned key, caller supplies only a discriminator (ADR-029 phase 2b)', () => {
  it('no longer accepts a caller-supplied whole idempotencyKey', () => {
    expect(Object.keys(CreateTransactionSchema.shape)).not.toContain('idempotencyKey');
  });

  it('carries an optional discriminator', () => {
    expect(Object.keys(CreateTransactionSchema.shape)).toContain('discriminator');
    expect(CreateTransactionSchema.shape.discriminator.isOptional()).toBe(true);
  });
});

// ADR-019 step 1: the transaction core's movement schemas are minimal — they carry only shared
// ledger vocabulary and name no sibling context's field (account/card/billMonth/billYear).
describe('CreateTransactionSchema / UpdateTransactionSchema — minimal core (ADR-019)', () => {
  it('CreateTransactionSchema names no context field', () => {
    expect(Object.keys(CreateTransactionSchema.shape)).not.toContain('account');
    expect(Object.keys(CreateTransactionSchema.shape)).not.toContain('card');
    expect(Object.keys(CreateTransactionSchema.shape)).not.toContain('billMonth');
    expect(Object.keys(CreateTransactionSchema.shape)).not.toContain('billYear');
  });

  it('UpdateTransactionSchema names no context field', () => {
    expect(Object.keys(UpdateTransactionSchema.shape)).not.toContain('account');
    expect(Object.keys(UpdateTransactionSchema.shape)).not.toContain('billMonth');
    expect(Object.keys(UpdateTransactionSchema.shape)).not.toContain('billYear');
  });

  it('transactionErrors no longer carries the field-tied bill errors (moved to cardErrors)', () => {
    expect(transactionErrors).not.toHaveProperty('billPeriodIncomplete');
    expect(transactionErrors).not.toHaveProperty('billAssignmentRequiresCard');
  });
});

describe('ConfirmTransactionSchema — confirm-with-edit (Design 014 phase B)', () => {
  it('accepts just id (status-only confirm)', () => {
    expect(ConfirmTransactionSchema.safeParse({ id: 'tx-1' }).success).toBe(true);
  });

  it('accepts amount and date together', () => {
    const result = ConfirmTransactionSchema.safeParse({ id: 'tx-1', amount: 25, date: '2026-06-10' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing id', () => {
    expect(ConfirmTransactionSchema.safeParse({ amount: 25 }).success).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(ConfirmTransactionSchema.safeParse({ id: 'tx-1', date: '06/10/2026' }).success).toBe(false);
  });
});

describe('transactionErrors — confirm-with-edit (Design 014 phase B)', () => {
  it('cannotConfirmFutureDated is a validation error naming the date', () => {
    const error = transactionErrors.cannotConfirmFutureDated('2099-01-01');
    expect(error.code).toBe('validation');
    if (error.code === 'validation') {
      expect(error.issues[0]).toContain('2099-01-01');
    }
  });

  it('confirmEditNotAllowedForTransfer points at update_account_transaction and pay_bill/revert_bill_payment', () => {
    expect(transactionErrors.confirmEditNotAllowedForTransfer.code).toBe('validation');
    expect(transactionErrors.confirmEditNotAllowedForTransfer.issues[0]).toContain('update_account_transaction');
    expect(transactionErrors.confirmEditNotAllowedForTransfer.issues[0]).toContain('pay_bill');
  });
});
