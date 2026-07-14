/**
 * The merchant→category learning edge (ADR-021): the account aggregate's FC/IS
 * `updateAccountTransaction` (`controllers/account/transaction.ts`) persists a user category
 * correction as this entity's own `Persistable`, riding in the *same* atomic batch as the
 * transaction update it came from (rule 5: composition is concatenation) — rather than a separate,
 * non-atomic `deps.merchants.strengthenFromTransaction` call after the fact. The still-unconverted
 * credit-card aggregate (`controllers/transaction/core.ts`'s `updateTransaction`, phase 2b) keeps
 * calling that repo method directly.
 */
export const MERCHANT_CATEGORY_ENTITY_TAG = 'merchantCategory';

/** No `id`/`version` — `merchant_category` is keyed by `(merchantKey, categoryId)` and every write
 *  is the same idempotent upsert ("insert weight=1, or increment on repeat" —
 *  `ON CONFLICT DO UPDATE SET weight = weight + 1`), never a `Persistable` `update`/`delete` in the
 *  versioned-entity sense. Always built as a `PersistOp.enum.insert` — see
 *  `diplomat/db/repos/merchants.ts`'s `merchantCategoryApplier`. */
export type MerchantCategoryEdge = { merchantKey: string; categoryId: string };
