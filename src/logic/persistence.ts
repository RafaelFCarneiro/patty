import { PersistOp, type Persistable } from '../models/persistable.js';

type InsertPersistable = Extract<Persistable, { op: typeof PersistOp.enum.insert }>;
type UpdatePersistable = Extract<Persistable, { op: typeof PersistOp.enum.update }>;
type DeletePersistable = Extract<Persistable, { op: typeof PersistOp.enum.delete }>;

/**
 * Builders for each `Persistable` write intent (ADR-021 / docs/functional-core-imperative-shell.md) — one
 * place every converted controller constructs the same tagged shape from, instead of hand-writing an
 * `{ op, entity, model }` object literal at each call site. Pure (no I/O); reused across every domain.
 *
 * NOTE for later phases: `Omit<X, 'op'>` below relies on `EntityTag`/`Persistable` currently having exactly
 * one member per op. `Omit` does not distribute correctly over a union, so once a second entity is added,
 * these signatures need revisiting (e.g. per-entity overloads) rather than assuming they still narrow
 * `entity`/`model` together.
 */
export const insert = (fields: Omit<InsertPersistable, 'op'>): Persistable => ({
  op: PersistOp.enum.insert,
  ...fields,
});

export const update = (fields: Omit<UpdatePersistable, 'op'>): Persistable => ({
  op: PersistOp.enum.update,
  ...fields,
});

export const remove = (fields: Omit<DeletePersistable, 'op'>): Persistable => ({
  op: PersistOp.enum.delete,
  ...fields,
});
