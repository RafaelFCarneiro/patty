import { PersistOp, type Persistable } from '../models/persistable.js';

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
