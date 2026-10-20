import { ok, okAsync, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard } from '../../common/result.js';
import { assertExclusivePeriodOrRange, periodBounds } from '../../logic/period.js';
import { addLocalizedLabels, nextCursorAfter, resolveCursorKey } from '../../logic/transaction.js';
import type { Page } from '../../models/page.js';
import {
  transactionErrors,
  type ResolvedSearchRefs,
  type SearchTransactions,
  type TransactionView,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCategoryRef, resolveSubCategoryRef } from '../resolve.js';

/** Resolves an optional name to an id; absent stays absent. */
const optionalId = <T extends { id: string }>(
  name: string | undefined,
  resolve: (name: string) => ResultAsync<T, AppError>,
): ResultAsync<string | null, AppError> => (name ? resolve(name).map((entity) => entity.id) : okAsync(null));

/** The only pieces of search_transactions' filter shape that need a repo lookup or a decode —
 *  everything else the repo needs is already on `input`. Shaping this into the flat SQL-filter
 *  object is diplomat/db's job (`toSearchFilters`), not the controller's. */
const resolveSearchRefs = (deps: Deps, input: SearchTransactions): ResultAsync<ResolvedSearchRefs, AppError> =>
  safeTry(async function* () {
    const accountId = yield* optionalId(input.account, (name) => resolveAccountRef(deps, name));
    const categoryId = yield* optionalId(input.category, (name) => resolveCategoryRef(deps, name));
    const subCategoryId = yield* optionalId(input.subCategory, (name) => resolveSubCategoryRef(deps, name));
    const cursorKey = yield* resolveCursorKey(input);
    return ok({ accountId, categoryId, subCategoryId, ...periodBounds(input), cursorKey });
  });

export const searchTransactions = (
  deps: Deps,
  input: SearchTransactions,
): ResultAsync<Page<TransactionView>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusivePeriodOrRange(input), transactionErrors.exclusivePeriodRange);
    const refs = yield* resolveSearchRefs(deps, input);

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
