import { describe, expect, it } from 'vitest';
import { ambiguous, notFound, validation } from '../../../src/models/error.js';
import { accountErrors } from '../../../src/models/account.js';
import { categoryErrors } from '../../../src/models/category.js';
import { cardErrors } from '../../../src/models/creditCard.js';
import { transactionErrors } from '../../../src/models/transaction.js';
import { billErrors } from '../../../src/models/bill.js';
import { tagErrors } from '../../../src/models/tag.js';

describe('shared error primitives', () => {
  it('validation() builds a ValidationError with code and issues', () => {
    const err = validation(['field is required', 'must be positive']);
    expect(err).toEqual({ code: 'validation', issues: ['field is required', 'must be positive'] });
  });

  it('notFound() builds a NotFound with computed code', () => {
    expect(notFound('account', 'Nubank', ['Itaú'])).toEqual({
      code: 'unknown_account',
      query: 'Nubank',
      candidates: ['Itaú'],
    });
  });

  it('ambiguous() builds an Ambiguous with computed code', () => {
    expect(ambiguous('card', 'Nu', ['Nubank', 'NuGold'])).toEqual({
      code: 'ambiguous_card',
      query: 'Nu',
      candidates: ['Nubank', 'NuGold'],
    });
  });
});

describe('per-model error builders', () => {
  it('categoryErrors.duplicateName carries entity and name', () => {
    expect(categoryErrors.duplicateName('category', 'Food')).toEqual({
      code: 'duplicate_name',
      entity: 'category',
      name: 'Food',
    });
    expect(categoryErrors.duplicateName('sub_category', 'Fast Food')).toEqual({
      code: 'duplicate_name',
      entity: 'sub_category',
      name: 'Fast Food',
    });
  });

  it('categoryErrors.inUse carries entity, name, and references', () => {
    const refs = { transactions: 5, recurring: 1, subCategories: 2 };
    expect(categoryErrors.inUse('category', 'Food', refs)).toEqual({
      code: 'in_use',
      entity: 'category',
      name: 'Food',
      references: refs,
    });
  });

  it('transactionErrors.categoryKindMismatch builds a hint phrased for the expense-kind remedy', () => {
    const err = transactionErrors.categoryKindMismatch('income', 'Food', 'expense');
    expect(err.code).toBe('category_kind_mismatch');
    expect(err.hint).toContain('expense-only');
    expect(err.hint).toContain('Food');
    // The remedy clause is tool-agnostic (add_account_expense/income have no `type` field to
    // "set") — grammar differs by branch ("an expense" vs bare "income"), so both need their own
    // assertion rather than relying on one branch to prove the other reads correctly.
    expect(err.hint).toContain('record this as an expense instead');
  });

  it('transactionErrors.categoryKindMismatch builds a hint phrased for the income-kind remedy', () => {
    const err = transactionErrors.categoryKindMismatch('expense', 'Salary', 'income');
    expect(err.code).toBe('category_kind_mismatch');
    expect(err.hint).toContain('income-only');
    expect(err.hint).toContain('Salary');
    expect(err.hint).toContain('record this as income instead');
  });

  it('cardErrors.duplicateName uses credit_card entity', () => {
    expect(cardErrors.duplicateName('Nubank')).toEqual({
      code: 'duplicate_name',
      entity: 'credit_card',
      name: 'Nubank',
    });
  });

  it('transactionErrors.notFound carries the id', () => {
    expect(transactionErrors.notFound('tx-123')).toEqual({
      code: 'unknown_transaction',
      id: 'tx-123',
    });
  });

  it('billErrors.notFound carries card, month, year', () => {
    expect(billErrors.notFound('Nubank', 6, 2026)).toEqual({
      code: 'unknown_bill',
      card: 'Nubank',
      month: 6,
      year: 2026,
    });
  });

  it('tagErrors.duplicateName uses tag entity', () => {
    expect(tagErrors.duplicateName('travel')).toEqual({
      code: 'duplicate_name',
      entity: 'tag',
      name: 'travel',
    });
  });

  it('accountErrors.creditTransferFromRejected embeds the account name', () => {
    const err = accountErrors.creditTransferFromRejected('Nubank');
    expect(err).toMatchObject({ code: 'validation' });
    if (err.code === 'validation') {
      expect(err.issues[0]).toContain('Nubank');
      expect(err.issues[0]).toContain('from');
    }
  });

  it('accountErrors.creditTransferToRejected embeds the account name', () => {
    const err = accountErrors.creditTransferToRejected('Nubank');
    expect(err).toMatchObject({ code: 'validation' });
    if (err.code === 'validation') {
      expect(err.issues[0]).toContain('Nubank');
      expect(err.issues[0]).toContain('to');
    }
  });

  it('accountErrors.crossCurrencyTransfer embeds both account details', () => {
    const err = accountErrors.crossCurrencyTransfer(
      { name: 'Checking', currency: 'BRL' },
      { name: 'Savings', currency: 'USD' },
    );
    expect(err).toMatchObject({ code: 'validation' });
    if (err.code === 'validation') {
      expect(err.issues[0]).toContain('Checking');
      expect(err.issues[0]).toContain('Savings');
    }
  });

  it('accountErrors static payloads have the right code', () => {
    expect(accountErrors.creditPostRejected.code).toBe('validation');
    expect(accountErrors.creditPaymentRejected.code).toBe('validation');
    expect(accountErrors.sameAccount.code).toBe('validation');
    // Transfer mutation policy (ADR-020 §4) — moved here from transactionErrors.
    expect(accountErrors.transferTypeImmutable.code).toBe('validation');
    expect(accountErrors.transferCategoryRejected.code).toBe('validation');
  });

  it('transactionErrors static payloads have the right code', () => {
    expect(transactionErrors.exclusiveCategorySubCategory.code).toBe('validation');
  });

  it('billErrors.noPayingAccount is a validation error', () => {
    expect(billErrors.noPayingAccount.code).toBe('validation');
  });

  it('cardErrors.currencyMismatch embeds both currencies', () => {
    const err = cardErrors.currencyMismatch('BRL', 'USD');
    expect(err).toMatchObject({ code: 'validation' });
    if (err.code === 'validation') {
      expect(err.issues[0]).toContain('BRL');
      expect(err.issues[0]).toContain('USD');
    }
  });
});
