import { describe, expect, it } from 'vitest'
import { resolveByName } from '../../../src/logic/resolve.js'

const accounts = [
  { id: '1', name: 'Nubank' },
  { id: '2', name: 'Itaú Corrente' },
  { id: '3', name: 'Itaú Poupança' },
  { id: '4', name: 'Carteira' },
]

describe('resolveByName', () => {
  it('finds exact match, case/accent-insensitive', () => {
    const r = resolveByName(accounts, 'nubank')
    expect(r).toMatchObject({ kind: 'found', entity: { id: '1' } })
    expect(resolveByName(accounts, 'itau corrente')).toMatchObject({ kind: 'found', entity: { id: '2' } })
  })

  it('finds single partial match', () => {
    expect(resolveByName(accounts, 'carteir')).toMatchObject({ kind: 'found', entity: { id: '4' } })
  })

  it('reports ambiguity with candidates', () => {
    const r = resolveByName(accounts, 'itau')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates).toEqual(['Itaú Corrente', 'Itaú Poupança'])
  })

  it('reports none with all candidates', () => {
    const r = resolveByName(accounts, 'bradesco')
    expect(r.kind).toBe('none')
    if (r.kind === 'none') expect(r.candidates).toHaveLength(4)
  })
})
