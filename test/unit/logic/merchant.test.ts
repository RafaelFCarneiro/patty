import { describe, expect, it } from 'vitest';
import {
  MERCHANT_LEARNING_WEIGHT_DELTA,
  normalizeMerchant,
  resolveMerchantCorrection,
  withMerchant,
  withMerchantLearning,
} from '../../../src/logic/merchant.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from '../../../src/models/merchant.js';
import { PersistOp, type Persistable } from '@rfc0/effect-runner';
import { TRANSACTION_ENTITY_TAG } from '../../../src/models/transaction.js';

describe('normalizeMerchant', () => {
  it('strips bank-statement noise', () => {
    expect(normalizeMerchant('PAG*UberTrip 99-SP')).toBe('ubertrip sp');
    expect(normalizeMerchant('COMPRA DEBITO IFOOD *IFD')).toBe('ifood ifd');
    expect(normalizeMerchant('PIX ENVIADO Padaria São João 123')).toBe('padaria sao joao');
  });

  it('strips accents, digits and symbols', () => {
    expect(normalizeMerchant('Drogaria São Paulo #442')).toBe('drogaria sao paulo');
    expect(normalizeMerchant('NETFLIX.COM')).toBe('netflix com');
  });
});

describe('resolveMerchantCorrection', () => {
  it('resolves the edge to strengthen when the category actually changed and a merchant is classified', () => {
    const existing = { merchant: 'uber', categoryId: 'cat-old' };
    expect(resolveMerchantCorrection(existing, 'cat-new')).toEqual({
      merchantKey: 'uber',
      categoryId: 'cat-new',
      weightDelta: MERCHANT_LEARNING_WEIGHT_DELTA,
      origin: 'history',
    });
  });

  it('resolves to null when the resolved category matches what the transaction already had', () => {
    const existing = { merchant: 'uber', categoryId: 'cat-old' };
    expect(resolveMerchantCorrection(existing, 'cat-old')).toBeNull();
  });

  it('resolves to null when the transaction has no classified merchant at all', () => {
    expect(resolveMerchantCorrection({ categoryId: 'cat-old' }, 'cat-new')).toBeNull();
  });

  it('resolves the edge even when the transaction previously had no category, as long as it has a merchant', () => {
    expect(resolveMerchantCorrection({ merchant: 'uber' }, 'cat-new')).toEqual({
      merchantKey: 'uber',
      categoryId: 'cat-new',
      weightDelta: MERCHANT_LEARNING_WEIGHT_DELTA,
      origin: 'history',
    });
  });

  it('resolves to null when no category was actually given (null or undefined)', () => {
    const existing = { merchant: 'uber', categoryId: 'cat-old' };
    expect(resolveMerchantCorrection(existing, null)).toBeNull();
    expect(resolveMerchantCorrection(existing, undefined)).toBeNull();
  });
});

describe('withMerchant — prepends the merchant Persistable a transaction insert/update implies (ADR-023)', () => {
  const txInsert: Persistable = { op: PersistOp.enum.insert, entity: TRANSACTION_ENTITY_TAG, model: {} };

  it('prepends a merchant insert when a merchant key is present', () => {
    expect(withMerchant([txInsert], 'uber')).toEqual([
      { op: PersistOp.enum.insert, entity: MERCHANT_ENTITY_TAG, model: { key: 'uber' } },
      txInsert,
    ]);
  });

  it('returns the batch unchanged when no merchant key is present', () => {
    expect(withMerchant([txInsert], undefined)).toEqual([txInsert]);
  });
});

describe('withMerchantLearning — appends the merchant + learning-edge Persistables a correction implies', () => {
  const txUpdate: Persistable = { op: PersistOp.enum.update, entity: TRANSACTION_ENTITY_TAG, model: { version: 0 } };
  const correction = {
    merchantKey: 'uber',
    categoryId: 'cat-new',
    weightDelta: MERCHANT_LEARNING_WEIGHT_DELTA,
    origin: 'history' as const,
  };

  it('appends a merchant insert, then the learning-edge insert, ordered before the edge (FK)', () => {
    expect(withMerchantLearning([txUpdate], correction)).toEqual([
      txUpdate,
      { op: PersistOp.enum.insert, entity: MERCHANT_ENTITY_TAG, model: { key: 'uber' } },
      { op: PersistOp.enum.insert, entity: MERCHANT_CATEGORY_ENTITY_TAG, model: correction },
    ]);
  });

  it('returns the batch unchanged when there is no correction to learn from', () => {
    expect(withMerchantLearning([txUpdate], null)).toEqual([txUpdate]);
  });
});
