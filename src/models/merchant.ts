/** The merchant→category learning edge: `updateAccountTransaction`/`updateCardTransaction` persist
 *  a user category correction as this entity's own `Persistable`, in the same atomic batch as the
 *  transaction update it came from — not a separate, non-atomic write after the fact. Both decide
 *  *which* edge to write via the shared `resolveMerchantCorrection` (`logic/merchant.ts`). */
export const MERCHANT_CATEGORY_ENTITY_TAG = 'merchantCategory';

/** No `id`/`version` — `merchant_category` is keyed by `(merchantKey, categoryId)` and every write
 *  is the same idempotent upsert ("insert weight=1, or increment on repeat" —
 *  `ON CONFLICT DO UPDATE SET weight = weight + 1`), never a `Persistable` `update`/`delete` in the
 *  versioned-entity sense. Always built as a `PersistOp.enum.insert` — see
 *  `diplomat/db/repos/merchants.ts`'s `merchantCategoryApplier`. */
export type MerchantCategoryEdge = { merchantKey: string; categoryId: string };
