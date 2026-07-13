import { describe, expect, it } from 'vitest';
import { insert, remove, update } from '../../../src/logic/persistence.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp } from '../../../src/models/persistable.js';

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
