import { z } from 'zod';
import type { Account, AccountEntity } from './account.js';

/** Entities the write-path unit of work can persist (ADR-021) — one member per converted flow;
 *  grows as later phases convert more aggregates. Constants over literals: the shell dispatches
 *  on `.enum.*`, never a bare string. */
export const EntityTag = z.enum(['account']);
export type EntityTag = z.infer<typeof EntityTag>;

/** The write intent a `Persistable` carries — named so call sites construct one via `.enum.*`,
 *  never a bare `'insert'`/`'update'`/`'delete'` string (constants over literals). */
export const PersistOp = z.enum(['insert', 'update', 'delete']);
export type PersistOp = z.infer<typeof PersistOp>;

/**
 * A write intent the functional core hands to the imperative shell (docs/functional-core-imperative-shell.md).
 * Entity-tagged and typed against the project's own models — never a stringly god-changeset. `insert`
 * carries a full new entity (id minted by the core) as the plain domain model — no `version`: a brand-new
 * row always starts at the same structural constant (the shell's own `INITIAL_VERSION`, `diplomat/db/
 * unitOfWork.ts`), which is nothing the core decides, so it's not part of what the core hands over. `update`
 * carries the full desired end-state as the versioned entity — `model.version` is the version the core read;
 * the shell computes the persisted version from it (`model.version + 1`) and applies
 * `... SET ..., version = ? WHERE id = ? AND version = ?`. `delete` carries just the id + the version read,
 * for the same versioned guard.
 */
export type Persistable =
  | { op: typeof PersistOp.enum.insert; entity: typeof EntityTag.enum.account; model: Account }
  | { op: typeof PersistOp.enum.update; entity: typeof EntityTag.enum.account; model: AccountEntity }
  | { op: typeof PersistOp.enum.delete; entity: typeof EntityTag.enum.account; id: string; version: number };

/** What a functional-core flow returns instead of performing its writes: the write batch plus the
 *  response the caller gets back once the shell has applied it. */
export type FlowOutcome<T> = { persist: Persistable[]; response: T };
