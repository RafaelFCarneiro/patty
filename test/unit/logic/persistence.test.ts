import { describe, expect, it, vi } from 'vitest';
import { entityDbAdapter, insert, outcomeFor, remove, update } from '../../../src/logic/persistence.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { INITIAL_VERSION, PersistOp, type Persistable, type PersistOutcome } from '../../../src/effects/persistable.js';

const account: Account = {
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
};

const accountEntity: AccountEntity = { ...account, version: 3 };

describe('logic/persistence — Persistable builders', () => {
  it('insert tags op:insert and carries the plain model, no version', () => {
    expect(insert({ entity: ACCOUNT_ENTITY_TAG, model: account })).toEqual({
      op: PersistOp.enum.insert,
      entity: ACCOUNT_ENTITY_TAG,
      model: account,
    });
  });

  it('insert carries an optional idempotencyKey on the envelope, alongside (never inside) the model', () => {
    expect(insert({ entity: ACCOUNT_ENTITY_TAG, model: account, idempotencyKey: 'k1' })).toEqual({
      op: PersistOp.enum.insert,
      entity: ACCOUNT_ENTITY_TAG,
      model: account,
      idempotencyKey: 'k1',
    });
  });

  it('insert omits idempotencyKey entirely when not given — read-first-dedup entities carry none', () => {
    const built = insert({ entity: ACCOUNT_ENTITY_TAG, model: account });
    expect(built).not.toHaveProperty('idempotencyKey');
  });

  it('update tags op:update and carries the versioned model', () => {
    expect(update({ entity: ACCOUNT_ENTITY_TAG, model: accountEntity })).toEqual({
      op: PersistOp.enum.update,
      entity: ACCOUNT_ENTITY_TAG,
      model: accountEntity,
    });
  });

  it('remove tags op:delete and carries just id + version', () => {
    expect(remove({ entity: ACCOUNT_ENTITY_TAG, id: account.id, version: 3 })).toEqual({
      op: PersistOp.enum.delete,
      entity: ACCOUNT_ENTITY_TAG,
      id: account.id,
      version: 3,
    });
  });

  it('is agnostic of any specific entity — works for a tag/model these builders have never seen', () => {
    // Proves logic/persistence.ts never needs a new case as more entities are converted (ADR-021):
    // any entity's own tag + model, unrelated to account, flows through the same generic builders.
    const widget = { entity: 'widget' as const, model: { id: 'w-1', color: 'red' } };
    expect(insert(widget)).toEqual({ op: PersistOp.enum.insert, ...widget });
  });
});

describe("outcomeFor — resolves a flow's own outcome by entity tag, not batch position (ADR-023)", () => {
  it('finds the matching outcome regardless of where it sits in the batch', () => {
    const outcomes: PersistOutcome[] = [
      { entity: 'merchant', applied: true },
      { entity: ACCOUNT_ENTITY_TAG, applied: true, read: { id: 'acc-1' } },
      { entity: 'bill', applied: true },
    ];
    expect(outcomeFor(ACCOUNT_ENTITY_TAG, outcomes)).toEqual({
      entity: ACCOUNT_ENTITY_TAG,
      applied: true,
      read: { id: 'acc-1' },
    });
  });

  it('finds it whether it leads or trails the batch — position never matters', () => {
    const leading: PersistOutcome[] = [
      { entity: ACCOUNT_ENTITY_TAG, applied: true },
      { entity: 'bill', applied: true },
    ];
    const trailing: PersistOutcome[] = [
      { entity: 'bill', applied: true },
      { entity: ACCOUNT_ENTITY_TAG, applied: true },
    ];
    expect(outcomeFor(ACCOUNT_ENTITY_TAG, leading).entity).toBe(ACCOUNT_ENTITY_TAG);
    expect(outcomeFor(ACCOUNT_ENTITY_TAG, trailing).entity).toBe(ACCOUNT_ENTITY_TAG);
  });

  it('throws when no outcome carries the requested entity tag — a drift, not a domain outcome', () => {
    expect(() => outcomeFor(ACCOUNT_ENTITY_TAG, [{ entity: 'bill', applied: true }])).toThrow(
      'outcomeFor: no persist outcome found for entity "account"',
    );
  });

  it('throws when more than one outcome carries the requested tag, rather than silently picking one', () => {
    const outcomes: PersistOutcome[] = [
      { entity: ACCOUNT_ENTITY_TAG, applied: true },
      { entity: ACCOUNT_ENTITY_TAG, applied: true },
    ];
    expect(() => outcomeFor(ACCOUNT_ENTITY_TAG, outcomes)).toThrow(
      'outcomeFor: multiple persist outcomes found for entity "account"',
    );
  });
});

const WIDGET_TAG = 'widget';
type Widget = { id: string; color: string };
type WidgetRow = Widget & { version: number; colorCode: string };

// Deliberately not the identity function — proves modelToDb, not some inline shaping, does the work.
const widgetToDb = vi.fn((model: Widget & { version: number }): WidgetRow => ({
  ...model,
  colorCode: model.color.toUpperCase(),
}));

describe('entityDbAdapter', () => {
  it('insert: bakes in INITIAL_VERSION before handing the model to modelToDb', () => {
    widgetToDb.mockClear();
    const { persistableToDb } = entityDbAdapter(WIDGET_TAG, widgetToDb);
    const p: Persistable = { op: PersistOp.enum.insert, entity: WIDGET_TAG, model: { id: 'w-1', color: 'red' } };

    expect(persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: WIDGET_TAG,
      model: { id: 'w-1', color: 'red', version: INITIAL_VERSION, colorCode: 'RED' },
    });
    expect(widgetToDb).toHaveBeenCalledWith({ id: 'w-1', color: 'red', version: INITIAL_VERSION });
  });

  it('update: hands the already-versioned model straight to modelToDb', () => {
    widgetToDb.mockClear();
    const { persistableToDb } = entityDbAdapter(WIDGET_TAG, widgetToDb);
    const model = { id: 'w-1', color: 'blue', version: 5 };
    const p: Persistable = { op: PersistOp.enum.update, entity: WIDGET_TAG, model };

    expect(persistableToDb(p)).toEqual({
      op: PersistOp.enum.update,
      entity: WIDGET_TAG,
      model: { id: 'w-1', color: 'blue', version: 5, colorCode: 'BLUE' },
    });
    expect(widgetToDb).toHaveBeenCalledWith({ id: 'w-1', color: 'blue', version: 5 });
  });

  it('delete: passes through unchanged — modelToDb is never called, there is no model to adapt', () => {
    widgetToDb.mockClear();
    const { persistableToDb } = entityDbAdapter(WIDGET_TAG, widgetToDb);
    const p: Persistable = { op: PersistOp.enum.delete, entity: WIDGET_TAG, id: 'w-1', version: 5 };

    expect(persistableToDb(p)).toEqual(p);
    expect(widgetToDb).not.toHaveBeenCalled();
  });

  it('no-ops on a persistable tagged for a different entity — modelToDb is never called', () => {
    widgetToDb.mockClear();
    const { persistableToDb } = entityDbAdapter(WIDGET_TAG, widgetToDb);
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'gadget', model: { notAWidget: true } };

    expect(persistableToDb(foreign)).toEqual(foreign);
    expect(widgetToDb).not.toHaveBeenCalled();
  });

  it('outcomeToDb maps every persistable in the batch through persistableToDb, leaving response untouched', () => {
    widgetToDb.mockClear();
    const { outcomeToDb } = entityDbAdapter(WIDGET_TAG, widgetToDb);
    const outcome = {
      persist: [{ op: PersistOp.enum.insert, entity: WIDGET_TAG, model: { id: 'w-1', color: 'red' } } as Persistable],
      response: { id: 'w-1' },
    };

    expect(outcomeToDb(outcome)).toEqual({
      persist: [
        {
          op: PersistOp.enum.insert,
          entity: WIDGET_TAG,
          model: { id: 'w-1', color: 'red', version: INITIAL_VERSION, colorCode: 'RED' },
        },
      ],
      response: { id: 'w-1' },
    });
  });

  it('on a mixed-entity batch, adapts only the matching persistables and passes the rest through', () => {
    widgetToDb.mockClear();
    const { outcomeToDb } = entityDbAdapter(WIDGET_TAG, widgetToDb);
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'gadget', model: { id: 'g-1' } };
    const outcome = {
      persist: [foreign, { op: PersistOp.enum.insert, entity: WIDGET_TAG, model: { id: 'w-1', color: 'red' } }],
      response: null,
    };

    expect(outcomeToDb(outcome)).toEqual({
      persist: [
        foreign,
        {
          op: PersistOp.enum.insert,
          entity: WIDGET_TAG,
          model: { id: 'w-1', color: 'red', version: INITIAL_VERSION, colorCode: 'RED' },
        },
      ],
      response: null,
    });
  });
});
