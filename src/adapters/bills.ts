import { BILL_ENTITY_TAG, type BillEntity } from '../models/bill.js';
import { INITIAL_VERSION, PersistOp, type FlowOutcome, type Persistable } from '../models/persistable.js';

/**
 * Adapts one bill `Persistable`'s model to db-row shape — hand-written rather than built from
 * `logic/persistence.ts`'s `entityDbAdapter`, since `update` needs to bypass row-shaping entirely:
 * `paymentTransactionId: undefined` means "leave the column unchanged" (drizzle's `.set()` drops
 * undefined-valued keys); `null` means "clear it" (models/bill.ts) — a distinction a uniform
 * `modelToDb` called on every update would collapse into always-clear. `insert` still bakes in
 * `INITIAL_VERSION`; no-ops on any other entity's `Persistable`.
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

/** Maps every `Persistable` in a flow's outcome through `persistableToDb` before `unitOfWork`. */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
  ...outcome,
  persist: outcome.persist.map(persistableToDb),
});
