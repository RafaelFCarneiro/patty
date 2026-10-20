import {
  ACCOUNT_ENTITY_TAG,
  AccountEntitySchema,
  type Account,
  type AccountEntity,
  AccountSchema,
  type AddAccountMovement,
  type CreateAccount,
  type CreateTransfer,
  type ImportAccountStatement,
  type UpdateAccount,
  type UpdateAccountTransaction,
} from '../models/account.js';
import * as persistence from '../logic/persistence.js';
import type { AccountRow } from '../wire/db/accounts.js';
import type * as wireIn from '../wire/in/accounts.js';

export const dbToModel = (row: AccountRow): Account =>
  AccountSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    initialBalance: row.initialBalance,
    currency: row.currency,
  });

/** Read variant carrying `version` — for flows building an `update`/`delete` `Persistable` from a
 *  fresh read (`updateAccount`/`deleteAccount`, `deleteCreditCard`'s internal-account lookup).
 *  Never used for a plain list/read response, so `version` can't leak onto the wire. */
export const dbToEntity = (row: AccountRow): AccountEntity =>
  AccountEntitySchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    initialBalance: row.initialBalance,
    currency: row.currency,
    version: row.version,
  });

/** Entity → row for the versioned unit of work (ADR-021) — the only account write path that
 *  needs `version` on the wire-db row. */
export const modelToDb = (entity: AccountEntity): AccountRow => ({
  id: entity.id,
  name: entity.name,
  type: entity.type,
  initialBalance: entity.initialBalance,
  currency: entity.currency,
  version: entity.version,
});

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(ACCOUNT_ENTITY_TAG, modelToDb);

export const createWireInToModel = (input: wireIn.CreateAccount): CreateAccount => input;
export const updateWireInToModel = (input: wireIn.UpdateAccount): UpdateAccount => input;
export const addAccountMovementWireInToModel = (input: wireIn.AddAccountMovement): AddAccountMovement => input;
export const transferWireInToModel = (input: wireIn.CreateTransfer): CreateTransfer => input;
export const updateAccountTransactionWireInToModel = (
  input: wireIn.UpdateAccountTransaction,
): UpdateAccountTransaction => input;
export const importAccountStatementWireInToModel = (input: wireIn.ImportAccountStatement): ImportAccountStatement =>
  input;
