import { z } from 'zod';

/** The write intent a `Persistable` carries — named so call sites construct one via `.enum.*`,
 *  never a bare `'insert'`/`'update'`/`'delete'` string (constants over literals). */
export const PersistOp = z.enum(['insert', 'update', 'delete']);
export type PersistOp = z.infer<typeof PersistOp>;

/** Every entity starts at this version — a structural fact of the versioning scheme itself, not a
 *  business decision, so a core's `insert` model never carries it. Each entity's own diplomat-edge
 *  adapter (e.g. `adapters/accounts.ts`'s `persistableToDb`, called explicitly by the MCP/REST
 *  handler before `withUnitOfWork` ever sees the batch) supplies it when it shapes the insert row
 *  — never the database's own `.default(0)` supplying it implicitly, and never `diplomat/db`
 *  either: the entity's own adapter is the one place model→row shaping happens. */
export const INITIAL_VERSION = 0;

/**
 * A write intent the functional core hands to the imperative shell (docs/functional-core-imperative-shell.md).
 * Generic over the entity's own tag + model, never a closed union enumerating every entity — this file stays
 * agnostic of any specific entity (constants over literals cuts both ways: a shared "god" `EntityTag` that
 * every entity module has to be added to is itself a magic-value smell). Each entity module owns its own tag
 * constant (e.g. `models/account.ts`'s `ACCOUNT_ENTITY_TAG`) and speaks this type generically —
 * `models/persistable.ts` never imports a specific entity's model.
 *
 * `insert` carries a full new entity (id minted by the core) as the plain domain model — no `version`: a
 * brand-new row always starts at the same structural constant (`INITIAL_VERSION`, above), which is nothing
 * the core decides, so it's not part of what the core hands over. `update` carries the full desired end-state
 * as the versioned entity — `model.version` is the version the core read; the entity's `EntityApplier`
 * (`diplomat/db`, most entities via the shared `versionedTableApplier` — see `accountApplier`) computes the
 * persisted version from it (`model.version + 1`) and applies
 * `... SET ..., version = ? WHERE id = ? AND version = ?`. `delete` carries just the id + the version read,
 * for the same versioned guard.
 */
export type Persistable<Tag extends string = string, Model = unknown> =
  | { op: typeof PersistOp.enum.insert; entity: Tag; model: Model }
  | { op: typeof PersistOp.enum.update; entity: Tag; model: Model & { version: number } }
  | { op: typeof PersistOp.enum.delete; entity: Tag; id: string; version: number };

/** What a functional-core flow returns instead of performing its writes: the write batch plus the
 *  response the caller gets back once the shell has applied it. */
export type FlowOutcome<T> = { persist: Persistable[]; response: T };
