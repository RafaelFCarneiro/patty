import { describe, expect, it } from 'vitest';
import { isCardRename } from '../../../src/logic/credit-card.js';

describe('isCardRename — precondition for a card rename cascade (Design 014 phase C)', () => {
  it('is false when newName is omitted', () => {
    expect(isCardRename('Nubank', undefined)).toBe(false);
  });

  it('is false when newName is the exact same name', () => {
    expect(isCardRename('Nubank', 'Nubank')).toBe(false);
  });

  it('is false for a case-only change — avoids a self-collision against the same name', () => {
    expect(isCardRename('Nubank', 'nubank')).toBe(false);
    expect(isCardRename('nubank', 'Nubank')).toBe(false);
  });

  it('is true for a genuine name change', () => {
    expect(isCardRename('Nubank', 'Nubank Platinum')).toBe(true);
  });
});
