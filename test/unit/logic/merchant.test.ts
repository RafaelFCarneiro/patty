import { describe, expect, it } from 'vitest';
import { isMerchantCorrection, normalizeMerchant } from '../../../src/logic/merchant.js';

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

describe('isMerchantCorrection', () => {
  it('is true when the category actually changed and the transaction has a classified merchant', () => {
    expect(isMerchantCorrection({ merchant: 'uber', categoryId: 'cat-old' }, 'cat-new')).toBe(true);
  });

  it('is false when the resolved category matches what the transaction already had (no correction)', () => {
    expect(isMerchantCorrection({ merchant: 'uber', categoryId: 'cat-old' }, 'cat-old')).toBe(false);
  });

  it('is false when the transaction has no classified merchant at all', () => {
    expect(isMerchantCorrection({ categoryId: 'cat-old' }, 'cat-new')).toBe(false);
  });

  it('is true even when the transaction previously had no category, as long as it has a merchant', () => {
    expect(isMerchantCorrection({ merchant: 'uber' }, 'cat-new')).toBe(true);
  });
});
