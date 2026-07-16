import {
  ACCOUNT_ENTITY_TAG,
  AccountEntitySchema,
  type Account,
  type AccountEntity,
  AccountSchema,
} from '../models/account.js';
import type {
  AddAccountMovement,
  CreateAccount,
  CreateTransfer,
  ImportAccountStatement,
  UpdateAccount,
  UpdateAccountTransaction,
} from '../models/account.js';
import { INITIAL_VERSION, PersistOp, type FlowOutcome, type Persistable } from '../models/persistable.js';
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

/**
 * Adapts one account `Persistable`'s `model` from domain shape to db-row shape (ADR-021 follow-up):
 * called explicitly by the MCP/REST handler, via `outcomeToDb` below, before the batch ever reaches
 * `withUnitOfWork` — so `diplomat/db` (the applier registered under `models/account.ts`'s
 * `ACCOUNT_ENTITY_TAG`) never calls `modelToDb` itself, only writes the row it's handed. No-ops on
 * a `Persistable` tagged for a different entity — `outcomeToDb` maps this over the *whole* batch, and
 * per docs/functional-core-imperative-shell.md rule 5 ("composition is concatenation"), a composed
 * flow's batch can carry other entities' persistables too; only `ACCOUNT_ENTITY_TAG`-tagged ones are
 * this adapter's to shape. `insert` has no `version` on its model (nothing the core decides — see
 * `models/persistable.ts`); it's added here, at the one place model→row shaping happens for this
 * entity. `delete` carries no model to adapt.
 */
export const persistableToDb = (p: Persistable): Persistable => {
  if (p.entity !== ACCOUNT_ENTITY_TAG) return p;
  switch (p.op) {
    case PersistOp.enum.insert:
      return { ...p, model: modelToDb({ ...(p.model as Account), version: INITIAL_VERSION }) };
    case PersistOp.enum.update:
      return { ...p, model: modelToDb(p.model as AccountEntity) };
    case PersistOp.enum.delete:
      return p;
    default: {
      const _exhaustive: never = p;
      throw new Error(`accountAdapters.persistableToDb: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Maps every `Persistable` in a flow's outcome through `persistableToDb` — the one call an
 *  account-producing MCP/REST handler makes between the controller and `unitOfWork`. Safe to run
 *  over a mixed-entity batch (composed flows, ADR-021 rule 5) — `persistableToDb` no-ops on
 *  anything not tagged `ACCOUNT_ENTITY_TAG`. */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
  ...outcome,
  persist: outcome.persist.map(persistableToDb),
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
