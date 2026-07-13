import { type Account, type AccountEntity, AccountSchema } from '../models/account.js';
import type {
  AddAccountMovement,
  CreateAccount,
  CreateTransfer,
  ImportAccountStatement,
  UpdateAccount,
  UpdateAccountTransaction,
} from '../models/account.js';
import type { AccountInsertRow, AccountRow } from '../wire/db/accounts.js';
import type * as wireIn from '../wire/in/accounts.js';

export const dbToModel = (row: AccountRow): Account =>
  AccountSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    initialBalance: row.initialBalance,
    currency: row.currency,
  });

/** Entity → row for the versioned unit of work applier (ADR-021) — the only account write path
 *  that needs `version` on the wire-db row. */
export const modelToDb = (entity: AccountEntity): AccountInsertRow => ({
  id: entity.id,
  name: entity.name,
  type: entity.type,
  initialBalance: entity.initialBalance,
  currency: entity.currency,
  version: entity.version,
});

export const createWireInToModel = (input: wireIn.CreateAccount): CreateAccount => input;
export const updateWireInToModel = (input: wireIn.UpdateAccount): UpdateAccount => input;
export const addAccountMovementWireInToModel = (input: wireIn.AddAccountMovement): AddAccountMovement => input;
export const transferWireInToModel = (input: wireIn.CreateTransfer): CreateTransfer => input;
export const updateAccountTransactionWireInToModel = (
  input: wireIn.UpdateAccountTransaction,
): UpdateAccountTransaction => input;
export const importAccountStatementWireInToModel = (input: wireIn.ImportAccountStatement): ImportAccountStatement =>
  input;
