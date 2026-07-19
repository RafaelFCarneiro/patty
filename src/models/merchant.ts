import type { ClassificationMethod } from './transaction.js';

/** `merchant_category.origin`'s actual domain (`schema.ts`): a learning edge is only ever
 *  observed via a rule match or a user's history of corrections — never `user`/`none`, which
 *  describe a *transaction's* own classification, not an edge's provenance. */
export type MerchantOrigin = Extract<ClassificationMethod, 'rule' | 'history'>;

/** A merchant referenced by a transaction or a learning edge. `key`-only, no `version` (ADR-023
 *  decision 1) — like `dashboards`, but simpler: only ever inserted, idempotently, never updated
 *  or removed. Any flow whose decision implies a merchant (a classified transaction, a learning
 *  edge) emits this `Persistable` itself, ordered before the entity that references it — the
 *  applier no longer creates it on their behalf. */
export const MERCHANT_ENTITY_TAG = 'merchant';

export type Merchant = { key: string };

/** The merchant→category learning edge: `updateAccountTransaction`/`updateCardTransaction` persist
 *  a user category correction as this entity's own `Persistable`, in the same atomic batch as the
 *  transaction update it came from — not a separate, non-atomic write after the fact. Both decide
 *  *which* edge to write via the shared `resolveMerchantCorrection` (`logic/merchant.ts`). */
export const MERCHANT_CATEGORY_ENTITY_TAG = 'merchantCategory';

/** No `id`/`version` — `merchant_category` is keyed by `(merchantKey, categoryId)` and every write
 *  is the same idempotent upsert-increment, never a `Persistable` `update`/`delete` in the
 *  versioned-entity sense. `weightDelta`/`origin` are chosen by `resolveMerchantCorrection`
 *  (`logic/merchant.ts`, ADR-023 decision 2); the applier applies exactly what it is handed:
 *  `weight: weightDelta` and `origin` on insert, `weight = weight + weightDelta` on conflict.
 *  **`origin` is insert-only on the conflict path** — deliberate, not implied by an omitted
 *  column: an edge first learned as `rule` stays `rule` no matter how many later corrections
 *  reinforce it. Always built as a `PersistOp.enum.insert` — see
 *  `diplomat/db/repos/merchants.ts`'s `merchantCategoryApplier`. */
export type MerchantCategoryEdge = {
  merchantKey: string;
  categoryId: string;
  weightDelta: number;
  origin: MerchantOrigin;
};
