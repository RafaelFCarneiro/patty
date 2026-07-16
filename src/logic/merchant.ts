/** Pure merchant-name normalization: bank-statement noise → stable merchant key. */

import type { MerchantCategoryEdge } from '../models/merchant.js';

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

/** Resolves the merchant-learning edge worth writing for a category update — or `null` when
 *  there's nothing to learn from: no category was actually resolved, it matches what the
 *  transaction already had, or the transaction has no classified merchant at all. Shared by
 *  `updateAccountTransaction` and `updateCardTransaction` — decided once, not duplicated. */
export const resolveMerchantCorrection = (
  existing: { merchant?: string; categoryId?: string },
  newCategoryId: string | null | undefined,
): MerchantCategoryEdge | null => {
  if (!newCategoryId || newCategoryId === existing.categoryId || !existing.merchant) return null;
  return { merchantKey: existing.merchant, categoryId: newCategoryId };
};
