import * as R from 'remeda';
import {
  INITIAL_VERSION,
  PersistOp,
  type FlowOutcome,
  type Persistable,
  type PersistOutcome,
} from '../models/persistable.js';

/**
 * Builders for each `Persistable` write intent (docs/functional-core-imperative-shell.md) — one
 * place every converted controller constructs the tagged shape from, instead of hand-writing an
 * `{ op, entity, model }` literal at each call site. Generic over the entity's own tag + model, so
 * this file never needs a new case as more entities convert. Pure (no I/O).
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

/** Extracts a flow's own outcome — the one whose `entity` matches `tag` — from a flow's
 *  idempotency-aware `response` function (`docs/functional-core-imperative-shell.md` rule 6).
 *  Addressed by entity tag, not batch position, so composing another entity's write around it
 *  (e.g. a merchant, ordered for its own FK) never changes which outcome resolves. Requires
 *  exactly one match: a flow that ever emits more than one `Persistable` under the same tag (e.g.
 *  `applyDueRecurring`'s per-occurrence inserts) can't use this — it needs its own outcome per
 *  item, not "the" outcome, and resolves them positionally instead. Throws rather than silently
 *  defaulting either way: `persist` and `response` having drifted out of sync is an internal
 *  invariant violation, not a domain outcome. */
export const outcomeFor = (tag: string, outcomes: PersistOutcome[]): PersistOutcome => {
  const matches = R.filter(outcomes, (o) => o.entity === tag);
  const [outcome] = matches;
  if (!outcome) throw new Error(`outcomeFor: no persist outcome found for entity "${tag}"`);
  if (matches.length > 1) throw new Error(`outcomeFor: multiple persist outcomes found for entity "${tag}"`);
  return outcome;
};

/**
 * Builds an entity's `persistableToDb`/`outcomeToDb` pair from just its own `modelToDb` — the
 * diplomat-edge counterpart to `diplomat/db/effects.ts`'s `versionedTableApplier`. `modelToDb` is
 * the one thing each entity supplies: `insert` bakes in `INITIAL_VERSION` before shaping the row,
 * `update` shapes the already-versioned model, `delete` carries no model to shape. For an entity
 * whose domain model already matches its row shape 1:1 (e.g. `tags`), `modelToDb` is just the
 * identity function.
 *
 * Not every entity fits: `bills` calls `modelToDb` identically for `insert`/`update`, but an
 * `update` genuinely needs `paymentTransactionId: undefined` (leave the column unchanged) to mean
 * something different from `null` (clear it) — a distinction a uniform `modelToDb` collapses — so
 * `adapters/bills.ts` keeps its own hand-written `persistableToDb` instead. Before wiring a new
 * `update` flow through here, check whether its `modelToDb` has the same `?? null` shape on an
 * optional field — that only stays safe as long as the flow always rebuilds the full entity
 * (`input ?? existing`, never leaving a field `undefined` to mean "leave unchanged"); a flow that
 * instead builds a partial update the way `payBill` does would hit the same collapse.
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
