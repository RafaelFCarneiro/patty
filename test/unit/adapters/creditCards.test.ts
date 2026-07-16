import { describe, expect, it } from 'vitest';
import { CREDIT_CARD_ENTITY_TAG, type CreditCard, type CreditCardEntity } from '../../../src/models/creditCard.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '../../../src/models/persistable.js';
import * as wireInCreditCards from '../../../src/wire/in/creditCards.js';
import * as creditCardAdapters from '../../../src/adapters/creditCards.js';
import type { CreditCardRow } from '../../../src/wire/db/creditCards.js';

describe('wireInToModel', () => {
  it('applies USD currency default when omitted', () => {
    const parsed = wireInCreditCards.CreateCreditCardSchema.parse({ name: 'Nubank', closingDay: 2, dueDay: 10 });
    expect(creditCardAdapters.wireInToModel(parsed)).toEqual({
      name: 'Nubank',
      currency: 'USD',
      closingDay: 2,
      dueDay: 10,
      limit: undefined,
    });
  });

  it('preserves explicit currency and optional limit when provided', () => {
    const parsed = wireInCreditCards.CreateCreditCardSchema.parse({
      name: 'USD Card',
      currency: 'USD',
      closingDay: 5,
      dueDay: 15,
      limit: 5000,
    });
    expect(creditCardAdapters.wireInToModel(parsed)).toEqual({
      name: 'USD Card',
      currency: 'USD',
      closingDay: 5,
      dueDay: 15,
      limit: 5000,
    });
  });

  it('requires name, closingDay, and dueDay', () => {
    expect(() => wireInCreditCards.CreateCreditCardSchema.parse({})).toThrow();
    expect(() => wireInCreditCards.CreateCreditCardSchema.parse({ name: 'X' })).toThrow();
  });
});

const cardRow = (overrides: Partial<CreditCardRow> = {}): CreditCardRow => ({
  id: 'card-1',
  name: 'Nubank',
  currency: 'BRL',
  closingDay: 10,
  dueDay: 20,
  limitAmount: null,
  accountId: 'acc-card-1',
  paymentAccountId: null,
  version: 0,
  ...overrides,
});

describe('dbToEntity', () => {
  it('decodes a flat row, defaulting absent limit/paymentAccountId to undefined', () => {
    expect(creditCardAdapters.dbToEntity(cardRow({ version: 5 }))).toEqual({
      id: 'card-1',
      name: 'Nubank',
      currency: 'BRL',
      closingDay: 10,
      dueDay: 20,
      accountId: 'acc-card-1',
      version: 5,
    });
  });

  it('decodes limit and paymentAccountId when present', () => {
    const entity = creditCardAdapters.dbToEntity(cardRow({ limitAmount: 5000, paymentAccountId: 'acc-payer-1' }));
    expect(entity.limit).toBe(5000);
    expect(entity.paymentAccountId).toBe('acc-payer-1');
  });
});

const card: CreditCard = {
  id: 'card-1',
  name: 'Nubank',
  currency: 'BRL',
  closingDay: 10,
  dueDay: 20,
  accountId: 'acc-card-1',
};

const cardEntity: CreditCardEntity = { ...card, version: 3 };

describe('modelToDb', () => {
  it('carries every field, including version, defaulting absent limit/paymentAccountId to null', () => {
    expect(creditCardAdapters.modelToDb(cardEntity)).toEqual(cardRow({ version: 3 }));
  });
});

describe('persistableToDb — ADR-021 follow-up: model→row adaptation lives at the diplomat edge', () => {
  it('insert: bakes in INITIAL_VERSION — the model never carries one', () => {
    const p: Persistable = { op: PersistOp.enum.insert, entity: CREDIT_CARD_ENTITY_TAG, model: card };
    expect(creditCardAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: CREDIT_CARD_ENTITY_TAG,
      model: cardRow({ version: INITIAL_VERSION }),
    });
  });

  it('delete: passes through unchanged — there is no model to adapt', () => {
    const p: Persistable = { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: 'card-1', version: 3 };
    expect(creditCardAdapters.persistableToDb(p)).toEqual(p);
  });

  it('no-ops on a persistable tagged for a different entity', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'account', model: { notACard: true } };
    expect(creditCardAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});

describe('outcomeToDb', () => {
  it('adapts only the credit-card persistables on a mixed-entity batch, passing the rest through', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'account', model: { id: 'acc-card-1' } };
    const outcome = {
      persist: [foreign, { op: PersistOp.enum.insert, entity: CREDIT_CARD_ENTITY_TAG, model: card } as Persistable],
      response: card,
    };
    expect(creditCardAdapters.outcomeToDb(outcome)).toEqual({
      persist: [
        foreign,
        { op: PersistOp.enum.insert, entity: CREDIT_CARD_ENTITY_TAG, model: cardRow({ version: INITIAL_VERSION }) },
      ],
      response: card,
    });
  });
});
