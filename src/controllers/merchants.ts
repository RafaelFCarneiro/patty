import { localizeCategoryName } from '../logic/category.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT, type MerchantSummary } from '../models/merchant.js';
import type { Deps } from './deps.js';

/** Backs `fintrack://merchants/top` — the user's most-transacted merchants with their dominant
 *  category, so an agent recognises recurring vocabulary (Feature Design 018). Read-only, no
 *  entity of its own; `deps.merchants.top` already picked the dominant category, this only
 *  locale-resolves its display name. */
export const topMerchants = async (deps: Deps, limit = DEFAULT_TOP_MERCHANTS_LIMIT): Promise<MerchantSummary[]> => {
  const [locale, rows] = await Promise.all([deps.locale(), deps.merchants.top(limit)]);
  return rows.map((row): MerchantSummary => ({
    merchant: row.merchant,
    transactionCount: row.transactionCount,
    categoryName: row.categoryName
      ? (localizeCategoryName(row.categoryName, row.categoryNames, locale) ?? row.categoryName)
      : null,
  }));
};
