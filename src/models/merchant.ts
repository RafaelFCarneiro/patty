import type { ClassificationMethod } from './transaction.js';

/** A learning edge is only ever observed via a rule match or a user's history of corrections —
 *  never `user`/`none`, which describe a transaction's own classification, not an edge's
 *  provenance. */
export type MerchantOrigin = Extract<ClassificationMethod, 'rule' | 'history'>;

/** `key`-only, no `version` — only ever inserted, idempotently, never updated or removed. */
export const MERCHANT_ENTITY_TAG = 'merchant';

export type Merchant = { key: string };

/** The merchant→category learning edge: `updateAccountTransaction`/`updateCardTransaction` persist
 *  a user category correction as this entity's own `Persistable`, in the same atomic batch as the
 *  transaction update it came from — not a separate, non-atomic write after the fact. Both decide
 *  *which* edge to write via the shared `resolveMerchantCorrection` (`logic/merchant.ts`). */
export const MERCHANT_CATEGORY_ENTITY_TAG = 'merchantCategory';

/** No `id`/`version` — `merchant_category` is keyed by `(merchantKey, categoryId)` and every write
 *  is an idempotent upsert-increment, never a `Persistable` `update`/`delete`. `weightDelta`
 *  applies as the initial weight on insert and the increment on conflict; `origin` is set only on
 *  insert — an edge first learned as `rule` stays `rule` no matter how many later corrections
 *  reinforce it. */
export type MerchantCategoryEdge = {
  merchantKey: string;
  categoryId: string;
  weightDelta: number;
  origin: MerchantOrigin;
};

/** Default row cap for `fintrack://merchants/top` (Feature Design 018) — a reference/vocabulary
 *  list, not a tunable report, so a static default rather than a caller-supplied parameter. */
export const DEFAULT_TOP_MERCHANTS_LIMIT = 20;

/** One row of `fintrack://merchants/top`: a merchant the user actually deals with, by transaction
 *  frequency, plus the category it's most often classified into. `categoryName` is `null` when
 *  every one of the merchant's transactions is uncategorized. */
export type MerchantSummary = {
  merchant: string;
  transactionCount: number;
  categoryName: string | null;
};

export const NOISE_PREFIXES =
  /^(pag\*?|pix\s+(enviado|recebido)?|compra\s+(no\s+)?(debito|credito)\s*|dbt\s+|crd\s+|tef\s+)/i;

export const MERCHANT_LEARNING_WEIGHT_DELTA = 1;
