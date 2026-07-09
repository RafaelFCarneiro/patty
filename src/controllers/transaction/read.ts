import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { periodRange } from '../../logic/period.js';
import {
  addLocalizedLabels,
  hasCategory,
  hasSubCategory,
  nextCursorAfter,
  resolveCursorKey,
} from '../../logic/transaction.js';
import type { Page } from '../../models/page.js';
import type { ResolvedSearchRefs, SearchTransactions, TransactionView } from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCategoryRef, resolveSubCategoryRef } from '../resolve.js';

export const searchTransactions = (
  deps: Deps,
  input: SearchTransactions,
): ResultAsync<Page<TransactionView>, AppError> =>
  safeTry(async function* () {
    const range = input.month && input.year ? periodRange({ month: input.month, year: input.year }) : null;
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const category = hasCategory(input) ? yield* resolveCategoryRef(deps, input.category) : null;
    const subCategory = hasSubCategory(input) ? yield* resolveSubCategoryRef(deps, input.subCategory) : null;
    const cursorKey = yield* resolveCursorKey(input);

    // The only pieces of search_transactions' filter shape that need a repo lookup or a decode —
    // everything else the repo needs is already on `input`. Shaping this pair into the flat
    // SQL-filter object is diplomat/db's job (`toSearchFilters`), not the controller's.
    const refs: ResolvedSearchRefs = {
      accountId: account?.id ?? null,
      categoryId: category?.id ?? null,
      subCategoryId: subCategory?.id ?? null,
      from: range?.from ?? null,
      to: range?.to ?? null,
      cursorKey,
    };

    // count is independent of locale/page — run all three concurrently rather than paying its
    // latency after the other two resolve.
    const [locale, page, total] = await Promise.all([
      deps.locale(),
      deps.transactions.search(input, refs),
      input.includeTotal ? deps.transactions.count(input, refs) : Promise.resolve(undefined),
    ]);

    const items = page.items.map(addLocalizedLabels(locale));
    const lastItem = R.last(items);
    const nextCursor = page.hasMore && lastItem ? nextCursorAfter(lastItem, input.sort, input.dir) : undefined;

    return ok({ items, nextCursor, total });
  });
