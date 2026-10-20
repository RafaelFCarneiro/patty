import { localizeCategoryName } from '../logic/category.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT, type MerchantSummary } from '../models/merchant.js';
import type { Deps } from './deps.js';

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
