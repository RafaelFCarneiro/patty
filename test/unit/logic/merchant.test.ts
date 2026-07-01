import { describe, expect, it } from 'vitest';
import { normalizeMerchant } from '../../../src/logic/merchant.js';

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
