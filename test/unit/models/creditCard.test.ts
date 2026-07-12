import { describe, expect, it } from 'vitest';
import {
  AddCardPurchaseSchema,
  cardErrors,
  UpdateCardTransactionSchema,
} from '../../../src/models/creditCard.js';

const baseCreate = {
  description: 'Coffee',
  amount: 10,
  type: 'expense' as const,
  card: 'Nubank',
  idempotencyKey: 'k-1',
};

describe('AddCardPurchaseSchema — composes up from the minimal core (ADR-019)', () => {
  it('accepts card + billMonth/billYear (card-only vocabulary the core no longer carries)', () => {
    const result = AddCardPurchaseSchema.safeParse({ ...baseCreate, billMonth: 6, billYear: 2026 });
    expect(result.success).toBe(true);
  });

  it('rejects account — a foreign field belonging to the sibling account aggregate (.strict())', () => {
    const result = AddCardPurchaseSchema.safeParse({ ...baseCreate, account: 'Nubank' });
    expect(result.success).toBe(false);
  });
});

describe('UpdateCardTransactionSchema — composes up from the minimal core (ADR-019)', () => {
  it('accepts billMonth/billYear (card-only reassignment vocabulary)', () => {
    const result = UpdateCardTransactionSchema.safeParse({ id: 'tx-1', billMonth: 6, billYear: 2026 });
    expect(result.success).toBe(true);
  });

  it('still accepts account — kept reachable so the controller can raise accountChangeRejectedForCard, ' +
    'rather than a generic .strict() unrecognized-key error (ADR-019 watchpoint)', () => {
    const result = UpdateCardTransactionSchema.safeParse({ id: 'tx-1', account: 'Nubank' });
    expect(result.success).toBe(true);
  });

  it('rejects a truly foreign field (.strict())', () => {
    const result = UpdateCardTransactionSchema.safeParse({ id: 'tx-1', notAField: true });
    expect(result.success).toBe(false);
  });
});

describe('cardErrors — field-tied bill errors moved here from transactionErrors (ADR-019 step 1)', () => {
  it('billPeriodIncomplete is a validation error about pairing', () => {
    expect(cardErrors.billPeriodIncomplete.code).toBe('validation');
    expect(cardErrors.billPeriodIncomplete.issues[0]).toContain('billMonth and billYear must be provided together');
  });

  it('billAssignmentRequiresCard is a validation error naming the card requirement', () => {
    expect(cardErrors.billAssignmentRequiresCard.code).toBe('validation');
    expect(cardErrors.billAssignmentRequiresCard.issues[0]).toContain('credit-card transaction');
  });
});
