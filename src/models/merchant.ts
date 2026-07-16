/**
 * The merchant→category learning edge (ADR-021): both aggregates' FC/IS update flows —
 * `controllers/account/transaction.ts`'s `updateAccountTransaction` and
 * `controllers/creditCard/transaction.ts`'s `updateCardTransaction` — persist a user category
 * correction as this entity's own `Persistable`, riding in the *same* atomic batch as the
 * transaction update it came from (rule 5: composition is concatenation) rather than a separate,
 * non-atomic write after the fact. Both decide *which* edge to write the same way, via the shared
 * `resolveMerchantCorrection` (`logic/merchant.ts`).
 */
export const MERCHANT_CATEGORY_ENTITY_TAG = 'merchantCategory';

/** No `id`/`version` — `merchant_category` is keyed by `(merchantKey, categoryId)` and every write
 *  is the same idempotent upsert ("insert weight=1, or increment on repeat" —
 *  `ON CONFLICT DO UPDATE SET weight = weight + 1`), never a `Persistable` `update`/`delete` in the
 *  versioned-entity sense. Always built as a `PersistOp.enum.insert` — see
 *  `diplomat/db/repos/merchants.ts`'s `merchantCategoryApplier`. */
export type MerchantCategoryEdge = { merchantKey: string; categoryId: string };
