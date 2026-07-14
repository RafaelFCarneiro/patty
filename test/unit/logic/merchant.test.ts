import { describe, expect, it } from 'vitest';
import { normalizeMerchant, resolveMerchantCorrection } from '../../../src/logic/merchant.js';

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
    expect(resolveMerchantCorrection(existing, 'cat-new')).toEqual({ merchantKey: 'uber', categoryId: 'cat-new' });
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
    });
  });

  it('resolves to null when no category was actually given (null or undefined)', () => {
    const existing = { merchant: 'uber', categoryId: 'cat-old' };
    expect(resolveMerchantCorrection(existing, null)).toBeNull();
    expect(resolveMerchantCorrection(existing, undefined)).toBeNull();
  });
});
