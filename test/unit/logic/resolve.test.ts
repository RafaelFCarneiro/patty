import { describe, expect, it } from 'vitest';
import { fold, resolveByName, resolveByNames } from '../../../src/logic/resolve.js';

const accounts = [
  { id: '1', name: 'Nubank' },
  { id: '2', name: 'Itaú Corrente' },
  { id: '3', name: 'Itaú Poupança' },
  { id: '4', name: 'Carteira' },
];

describe('resolveByName', () => {
  it('finds exact match, case/accent-insensitive', () => {
    const r = resolveByName(accounts, 'nubank');
    expect(r).toMatchObject({ kind: 'found', entity: { id: '1' } });
    expect(resolveByName(accounts, 'itau corrente')).toMatchObject({ kind: 'found', entity: { id: '2' } });
  });

  it('finds single partial match', () => {
    expect(resolveByName(accounts, 'carteir')).toMatchObject({ kind: 'found', entity: { id: '4' } });
  });

  it('reports ambiguity with candidates', () => {
    const r = resolveByName(accounts, 'itau');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates).toEqual(['Itaú Corrente', 'Itaú Poupança']);
  });

  it('reports none with all candidates', () => {
    const r = resolveByName(accounts, 'bradesco');
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.candidates).toHaveLength(4);
  });
});

describe('fold', () => {
  it('strips diacritics and lowercases', () => {
    expect(fold('Saúde')).toBe('saude');
    expect(fold('Alimentação')).toBe('alimentacao');
    expect(fold('  Café  ')).toBe('cafe');
  });
});

describe('resolveByNames (synonym resolution)', () => {
  const categories = [
    { id: 'cat-food', name: 'Alimentação' },
    { id: 'cat-health', name: 'Saúde' },
  ];
  const synonyms = (cat: { id: string }) => {
    const map: Record<string, string[]> = {
      'cat-food': ['Food', 'Alimentación'],
      'cat-health': ['Health', 'Salud'],
    };
    return map[cat.id] ?? [];
  };

  it('resolves via synonym when primary name does not match', () => {
    const r = resolveByNames(categories, 'Food', synonyms);
    expect(r).toMatchObject({ kind: 'found', entity: { id: 'cat-food' } });
  });

  it('resolves accent-insensitive synonym match', () => {
    const r = resolveByNames(categories, 'Alimentacion', synonyms);
    expect(r).toMatchObject({ kind: 'found', entity: { id: 'cat-food' } });
  });

  it('resolves primary name with diacritics stripped', () => {
    const r = resolveByNames(categories, 'saude', synonyms);
    expect(r).toMatchObject({ kind: 'found', entity: { id: 'cat-health' } });
  });

  it('returns ambiguous primary without falling through to synonyms', () => {
    const entities = [
      { id: 'a', name: 'Itaú Corrente' },
      { id: 'b', name: 'Itaú Poupança' },
    ];
    const onlyMatchA = (e: { id: string }) => (e.id === 'a' ? ['Itaú'] : []);
    const r = resolveByNames(entities, 'itau', onlyMatchA);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates).toEqual(['Itaú Corrente', 'Itaú Poupança']);
  });

  it('falls through to synonyms only when primary is none', () => {
    const r = resolveByNames(categories, 'Health', synonyms);
    expect(r).toMatchObject({ kind: 'found', entity: { id: 'cat-health' } });
  });
});
