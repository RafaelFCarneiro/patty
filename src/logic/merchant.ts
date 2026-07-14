/** Pure merchant-name normalization: bank-statement noise → stable merchant key. */

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

/**
 * True when a resolved `newCategoryId` is a genuine correction (differs from what the transaction
 * already had) worth strengthening the merchant→category learning edge for — only possible when
 * the transaction has a classified merchant at all. Narrows `existing.merchant` to `string` on
 * `true`, so a caller never needs its own non-null assertion. Callers narrow `newCategoryId` to
 * `string` themselves first (`if (categoryId && isMerchantCorrection(existing, categoryId))`) —
 * this function takes it as already-resolved, not optional, so it stays a single-purpose
 * comparison rather than also being an emptiness check. Shared by `controllers/transaction/core.ts`'s
 * (still repo-driven) `updateTransaction` and `controllers/account/transaction.ts`'s FC/IS
 * `updateAccountTransaction` — the one place this business rule is decided, not duplicated.
 */
export const isMerchantCorrection = (
  existing: { merchant?: string; categoryId?: string },
  newCategoryId: string,
): existing is { merchant: string; categoryId?: string } =>
  newCategoryId !== existing.categoryId && !!existing.merchant;
