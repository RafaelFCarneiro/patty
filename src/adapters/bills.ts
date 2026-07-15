import { BILL_ENTITY_TAG, type BillEntity } from '../models/bill.js';
import { INITIAL_VERSION, PersistOp, type FlowOutcome, type Persistable } from '../models/persistable.js';

/**
 * Adapts one bill `Persistable`'s `model` from domain shape to db-row shape (ADR-021 phase 2b),
 * mirroring `adapters/accounts.ts`'s `persistableToDb` — called explicitly by the MCP/REST handler,
 * via `outcomeToDb` below, before the batch ever reaches `withUnitOfWork`, so `diplomat/db` (the
 * `billApplier`, registered under `BILL_ENTITY_TAG`) never adapts a model itself, only writes the
 * row it's handed. No-ops on a `Persistable` tagged for a different entity — a card-purchase flow's
 * batch also carries a `TRANSACTION_ENTITY_TAG` persistable (rule 5), only this entity's own is this
 * adapter's to shape. `insert` has no `version` on its model (nothing the core decides — see
 * `models/persistable.ts`); it's added here. `update`/`delete` already carry everything the applier
 * needs (`BillEntity`'s field names already match the `bills` table's drizzle column properties —
 * unlike transactions/accounts, no renaming is needed here, only the version injection).
 */
export const persistableToDb = (p: Persistable): Persistable => {
  if (p.entity !== BILL_ENTITY_TAG) return p;
  switch (p.op) {
    case PersistOp.enum.insert:
      return { ...p, model: { ...(p.model as BillEntity), version: INITIAL_VERSION } };
    case PersistOp.enum.update:
      return p;
    case PersistOp.enum.delete:
      return p;
    default: {
      const _exhaustive: never = p;
      throw new Error(`billAdapters.persistableToDb: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Maps every `Persistable` in a flow's outcome through `persistableToDb` — the one call a
 *  bill-producing MCP/REST handler makes between the controller and `unitOfWork`. Safe over a
 *  mixed-entity batch (composed flows, ADR-021 rule 5) — `persistableToDb` no-ops on anything not
 *  tagged `BILL_ENTITY_TAG`. */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
  ...outcome,
  persist: outcome.persist.map(persistableToDb),
});
