import { describe, expect, it } from 'vitest';
import {
  CreateTransactionSchema,
  transactionErrors,
  UpdateTransactionSchema,
} from '../../../src/models/transaction.js';

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
