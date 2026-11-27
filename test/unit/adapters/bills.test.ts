import { describe, expect, it } from 'vitest';
import * as billAdapters from '../../../src/adapters/bills.js';
import { BILL_ENTITY_TAG, BillStatus, type BillEntity } from '../../../src/models/bill.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '@rfc0/effect-runner';

const bill: BillEntity = {
  id: 'bill-1',
  creditCardId: 'card-1',
  month: 6,
  year: 2026,
  closeDate: '2026-06-28',
  dueDate: '2026-07-05',
  status: BillStatus.enum.open,
};

describe('persistableToDb (bills)', () => {
  it('insert: bakes in INITIAL_VERSION — the model never carries one', () => {
    const p: Persistable = { op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model: bill };
    expect(billAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: BILL_ENTITY_TAG,
      model: { ...bill, version: INITIAL_VERSION },
    });
  });

  it('update: carries the entity (with its expected version) as the row', () => {
    const update: Persistable = {
      op: PersistOp.enum.update,
      entity: BILL_ENTITY_TAG,
      model: { ...bill, status: BillStatus.enum.paid, version: 3 } as BillEntity & { version: number },
    };
    expect(billAdapters.persistableToDb(update)).toEqual(update);
  });

  it('delete: passes through unchanged — there is no model to adapt', () => {
    const p: Persistable = { op: PersistOp.enum.delete, entity: BILL_ENTITY_TAG, id: 'bill-1', version: 3 };
    expect(billAdapters.persistableToDb(p)).toEqual(p);
  });

  it('no-ops on a persistable tagged for a different entity', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'account', model: { notABill: true } };
    expect(billAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});

describe('outcomeToDb (bills)', () => {
  it('maps every persistable in the batch through persistableToDb, leaving response untouched', () => {
    const outcome = {
      persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model: bill } as Persistable],
      response: bill,
    };
    expect(billAdapters.outcomeToDb(outcome)).toEqual({
      persist: [{ op: PersistOp.enum.insert, entity: BILL_ENTITY_TAG, model: { ...bill, version: INITIAL_VERSION } }],
      response: bill,
    });
  });
});
