import { PersistOp, type Persistable, type PersistOutcome } from '../models/persistable.js';

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
