import { describe, expect, it } from 'vitest'
import * as accountAdapters from './accounts.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('dbToModel', () => {
  it('decodes node + currency column, defaulting initialBalance for legacy nodes', () => {
    const account = accountAdapters.dbToModel({
      a: node({ id: 'acc-1', name: 'Nubank', type: 'checking' }),
      currency: 'BRL',
    })
    expect(account).toEqual({
      id: 'acc-1',
      name: 'Nubank',
      type: 'checking',
      currency: 'BRL',
      initialBalance: 0,
    })
  })

  it('rejects invalid records (decode at the boundary)', () => {
    expect(() =>
      accountAdapters.dbToModel({ a: node({ id: 'x', name: '', type: 'checking' }), currency: 'BRL' }),
    ).toThrow()
  })
})
