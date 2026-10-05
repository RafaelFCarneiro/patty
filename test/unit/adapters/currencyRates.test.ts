import { describe, expect, it } from 'vitest';
import * as currencyRateAdapters from '../../../src/adapters/currencyRates.js';
import { CURRENCY_RATE_ENTITY_TAG, type CurrencyRateEntity } from '../../../src/models/currencyRate.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '@rfc0/effect-runner';
import type { CurrencyRateRow } from '../../../src/wire/db/currencyRates.js';

const row: CurrencyRateRow = {
  id: 'rate-1',
  fromCode: CurrencyCode.enum.USD,
  toCode: CurrencyCode.enum.BRL,
  rate: 5.12,
  asOf: '2026-08-10T12:00:00.000Z',
  source: 'PTAX',
  version: 2,
};

describe('dbToEntity', () => {
  it('maps a db row to the entity 1:1', () => {
    expect(currencyRateAdapters.dbToEntity(row)).toEqual({
      id: 'rate-1',
      fromCode: CurrencyCode.enum.USD,
      toCode: CurrencyCode.enum.BRL,
      rate: 5.12,
      asOf: '2026-08-10T12:00:00.000Z',
      source: 'PTAX',
      version: 2,
    });
  });

  it('carries a null source through unchanged', () => {
    expect(currencyRateAdapters.dbToEntity({ ...row, source: null }).source).toBeNull();
  });
});

const entity: CurrencyRateEntity = {
  id: 'rate-1',
  fromCode: CurrencyCode.enum.USD,
  toCode: CurrencyCode.enum.BRL,
  rate: 5.12,
  asOf: '2026-08-10T12:00:00.000Z',
  source: 'PTAX',
  version: 2,
};

describe('modelToDb', () => {
  it('is the identity — a versioned entity is already row-shaped', () => {
    expect(currencyRateAdapters.modelToDb(entity)).toEqual(row);
  });
});

describe('persistableToDb (currency rates)', () => {
  it('insert: bakes in INITIAL_VERSION', () => {
    const p: Persistable = {
      op: PersistOp.enum.insert,
      entity: CURRENCY_RATE_ENTITY_TAG,
      model: {
        id: 'rate-1',
        fromCode: CurrencyCode.enum.USD,
        toCode: CurrencyCode.enum.BRL,
        rate: 5.12,
        asOf: '2026-08-10T12:00:00.000Z',
        source: null,
      },
    };
    expect(currencyRateAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: CURRENCY_RATE_ENTITY_TAG,
      model: { ...(p.model as object), version: INITIAL_VERSION },
    });
  });

  it('no-ops on a persistable tagged for a different entity', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'budget', model: { notARate: true } };
    expect(currencyRateAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});

describe('bulkResultToWireOut', () => {
  it('passes an ok item through unchanged', () => {
    const items = [
      {
        status: 'ok' as const,
        rate: { from: CurrencyCode.enum.USD, to: CurrencyCode.enum.BRL, rate: 5, asOf: '2026-08-10T12:00:00.000Z' },
      },
    ];
    expect(currencyRateAdapters.bulkResultToWireOut(items)).toEqual({ items });
  });

  it('collapses an AppError to a plain string on an error item', () => {
    const items = [
      {
        status: 'error' as const,
        from: CurrencyCode.enum.USD,
        to: CurrencyCode.enum.USD,
        error: { code: 'validation' as const, issues: ['from and to currencies must differ'] },
      },
    ];
    const result = currencyRateAdapters.bulkResultToWireOut(items);
    expect(result.items[0]).toEqual({
      status: 'error',
      from: CurrencyCode.enum.USD,
      to: CurrencyCode.enum.USD,
      error: 'validation: from and to currencies must differ',
    });
  });
});
