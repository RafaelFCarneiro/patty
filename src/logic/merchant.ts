/** Pure merchant-name normalization: bank-statement noise → stable merchant key. */

import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG, type MerchantCategoryEdge } from '../models/merchant.js';
import type { Persistable } from '../models/persistable.js';
import { ClassificationMethod } from '../models/transaction.js';
import { insert } from './persistence.js';

const NOISE_PREFIXES = /^(pag\*?|pix\s+(enviado|recebido)?|compra\s+(no\s+)?(debito|credito)\s*|dbt\s+|crd\s+|tef\s+)/i;

export const normalizeMerchant = (description: string): string =>
  description
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(NOISE_PREFIXES, '')
    .replace(/[*_#-]/g, ' ')
    .replace(/\d+/g, ' ') // card suffixes, dates, amounts
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** What a single user correction strengthens a merchant→category edge by (ADR-023 decision 2). */
export const MERCHANT_LEARNING_WEIGHT_DELTA = 1;

/** Resolves the merchant-learning edge worth writing for a category update — or `null` when
 *  there's nothing to learn from: no category was actually resolved, it matches what the
 *  transaction already had, or the transaction has no classified merchant at all. Shared by
 *  `updateAccountTransaction` and `updateCardTransaction` — decided once, not duplicated.
 *  `weightDelta`/`origin` are stated here, in the core, rather than hardcoded by the applier
 *  (ADR-023 decision 2) — today's values, `1` and `history`. */
export const resolveMerchantCorrection = (
  existing: { merchant?: string; categoryId?: string },
  newCategoryId: string | null | undefined,
): MerchantCategoryEdge | null => {
  if (!newCategoryId || newCategoryId === existing.categoryId || !existing.merchant) return null;
  return {
    merchantKey: existing.merchant,
    categoryId: newCategoryId,
    weightDelta: MERCHANT_LEARNING_WEIGHT_DELTA,
    origin: ClassificationMethod.enum.history,
  };
};

/** Prepends the merchant `Persistable` a transaction's own `merchantKey` implies (ADR-023 rule
 *  5) — `transactions.merchant_key` FKs `merchants.key`, so the merchant write must precede the
 *  transaction write in the batch — or returns `persist` unchanged when the entity carries no
 *  merchant key. Response resolution is by entity tag (`logic/persistence.ts`'s `outcomeFor`),
 *  never by position, so this ordering exists only to satisfy the FK. */
export const withMerchant = (persist: Persistable[], merchantKey: string | undefined): Persistable[] =>
  merchantKey ? [insert({ entity: MERCHANT_ENTITY_TAG, model: { key: merchantKey } }), ...persist] : persist;

/** Appends the merchant + merchant-learning-edge `Persistable`s a category correction implies
 *  (ADR-023 rule 5) — the merchant precedes the edge (`merchant_category.merchant_key` FKs
 *  `merchants.key`) — or returns `persist` unchanged when there's nothing to learn. */
export const withMerchantLearning = (persist: Persistable[], correction: MerchantCategoryEdge | null): Persistable[] =>
  correction
    ? [
        ...persist,
        insert({ entity: MERCHANT_ENTITY_TAG, model: { key: correction.merchantKey } }),
        insert({ entity: MERCHANT_CATEGORY_ENTITY_TAG, model: correction }),
      ]
    : persist;
