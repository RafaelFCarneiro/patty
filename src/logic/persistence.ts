import {
  INITIAL_VERSION,
  PersistOp,
  type FlowOutcome,
  type Persistable,
  type PersistOutcome,
} from '../models/persistable.js';

/**
 * Builders for each `Persistable` write intent (ADR-021 / docs/functional-core-imperative-shell.md) — one
 * place every converted controller constructs the same tagged shape from, instead of hand-writing an
 * `{ op, entity, model }` object literal at each call site. Generic over the entity's own tag + model (each
 * entity module owns those — e.g. `models/account.ts`'s `ACCOUNT_ENTITY_TAG`) — this file is agnostic of any
 * specific entity and never needs a new case as more entities are converted. Pure (no I/O).
 */
export const insert = <Tag extends string, Model>(fields: { entity: Tag; model: Model }): Persistable<Tag, Model> => ({
  op: PersistOp.enum.insert,
  ...fields,
});

export const update = <Tag extends string, Model extends { version: number }>(fields: {
  entity: Tag;
  model: Model;
}): Persistable<Tag, Model> => ({
  op: PersistOp.enum.update,
  ...fields,
});

export const remove = <Tag extends string>(fields: { entity: Tag; id: string; version: number }): Persistable<Tag> => ({
  op: PersistOp.enum.delete,
  ...fields,
});

/** Extracts the primary outcome — `persist[0]`'s — from a flow's idempotency-aware `response`
 *  function (`docs/functional-core-imperative-shell.md` rule 6): the entity the flow itself is
 *  about always leads the batch, even when composed with another entity's persistable afterward
 *  (rule 5 — e.g. `updateAccountTransaction` appending a merchant-learning edge). Throws rather
 *  than silently defaulting: an empty `outcomes` here would mean the flow's own `persist` batch and
 *  its `response` function have drifted out of sync — an internal invariant violation, not a
 *  domain outcome. */
export const firstOutcome = (outcomes: PersistOutcome[]): PersistOutcome => {
  const [outcome] = outcomes;
  if (!outcome) throw new Error('firstOutcome: expected at least one persist outcome, got none');
  return outcome;
};

/** `firstOutcome`'s counterpart for a flow whose own entity trails the batch instead of leading it
 *  (e.g. `addCardPurchase`/`updateCardTransaction`, whose transaction row FKs to a bill that must
 *  be written first). Same "drift is a bug, not a domain outcome" reasoning as `firstOutcome`. */
export const lastOutcome = (outcomes: PersistOutcome[]): PersistOutcome => {
  const outcome = outcomes[outcomes.length - 1];
  if (!outcome) throw new Error('lastOutcome: expected at least one persist outcome, got none');
  return outcome;
};

/**
 * Builds an entity's `persistableToDb`/`outcomeToDb` pair from just its own `modelToDb` — the
 * diplomat-edge counterpart to `diplomat/db/effects.ts`'s `versionedTableApplier`: every entity's
 * adapter followed the same op-switch shape (no-op on a foreign entity tag; `insert` bakes in
 * `INITIAL_VERSION` before shaping the row; `update` shapes the already-versioned model; `delete`
 * carries no model to shape) by hand, so the shape itself moved here once, entity-agnostic like the
 * rest of this file. `modelToDb` is the one thing each entity still supplies — for an entity whose
 * domain model already matches its row shape 1:1 (e.g. `tags`), that's the identity function. Not
 * every entity fits: `bills` calls `modelToDb` identically for `insert`/`update` here, but an
 * `update` genuinely needs `paymentTransactionId: undefined` (leave the column unchanged) to mean
 * something different from `null` (clear it) — a distinction a uniform `modelToDb` collapses — so
 * `adapters/bills.ts` keeps its own hand-written `persistableToDb` instead. Before wiring a new
 * `update` flow through here (e.g. a future `updateCreditCard`/`updateCategory`), check whether its
 * `modelToDb` has the same `?? null` shape on an optional field (`creditCards.ts`'s `limit`/
 * `paymentAccountId`, `categories.ts`'s `parentId`) — that only stays safe as long as the flow always
 * rebuilds the full entity (`input ?? existing`, never leaving a field `undefined` to mean "leave
 * unchanged"); a flow that instead builds a partial update the way bills' `payBill` does would hit
 * the exact same collapse.
 */
type EntityDbAdapter = {
  persistableToDb: (p: Persistable) => Persistable;
  outcomeToDb: <T>(outcome: FlowOutcome<T>) => FlowOutcome<T>;
};

export const entityDbAdapter = <Tag extends string, Model, Row extends { version: number }>(
  entity: Tag,
  modelToDb: (model: Model & { version: number }) => Row,
): EntityDbAdapter => {
  const persistableToDb = (p: Persistable): Persistable => {
    if (p.entity !== entity) return p;
    switch (p.op) {
      case PersistOp.enum.insert:
        return { ...p, model: modelToDb({ ...(p.model as Model), version: INITIAL_VERSION }) };
      case PersistOp.enum.update:
        return { ...p, model: modelToDb(p.model as Model & { version: number }) };
      case PersistOp.enum.delete:
        return p;
      default: {
        const _exhaustive: never = p;
        throw new Error(`entityDbAdapter(${entity}): unhandled persistable op ${JSON.stringify(_exhaustive)}`);
      }
    }
  };

  const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> => ({
    ...outcome,
    persist: outcome.persist.map(persistableToDb),
  });

  return { persistableToDb, outcomeToDb };
};
