import { describe, expect, it } from 'vitest';
import { insert, remove, update } from '../../../src/logic/persistence.js';
import { AccountType, type Account, type AccountEntity } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { EntityTag, PersistOp } from '../../../src/models/persistable.js';

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
    expect(insert({ entity: EntityTag.enum.account, model: account })).toEqual({
      op: PersistOp.enum.insert,
      entity: EntityTag.enum.account,
      model: account,
    });
  });

  it('update tags op:update and carries the versioned model', () => {
    expect(update({ entity: EntityTag.enum.account, model: accountEntity })).toEqual({
      op: PersistOp.enum.update,
      entity: EntityTag.enum.account,
      model: accountEntity,
    });
  });

  it('remove tags op:delete and carries just id + version', () => {
    expect(remove({ entity: EntityTag.enum.account, id: account.id, version: 3 })).toEqual({
      op: PersistOp.enum.delete,
      entity: EntityTag.enum.account,
      id: account.id,
      version: 3,
    });
  });
});
