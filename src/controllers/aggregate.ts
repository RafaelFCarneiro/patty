import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import { shapeAggregateResult, wantsDisplayConversion } from '../logic/aggregate.js';
import { consolidateInCurrency } from '../logic/currencyRate.js';
import { decimalsLookup } from '../logic/money.js';
import { assertHasPeriodOrRange, resolveDateRange } from '../logic/period.js';
import { aggregateErrors, type CurrencyBlock, type ResolvedAggregateSpending } from '../models/aggregate.js';
import type { AggregateResult } from '../models/aggregate.js';
import type { CurrencyCode, DecimalsFor } from '../models/money.js';
import type { Deps } from './deps.js';
import { resolveAccountRef, resolveCategoryRef } from './resolve.js';

const resolveAggregateRefs = (
  deps: Deps,
  input: Pick<ResolvedAggregateSpending, 'account' | 'category'>,
): ResultAsync<{ accountId: string | null; categoryId: string | null }, AppError> =>
  safeTry(async function* () {
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    return ok({ accountId: account?.id ?? null, categoryId: category?.id ?? null });
  });

const convertBlockTotals = async (
  deps: Deps,
  displayCurrency: CurrencyCode,
  currencies: readonly CurrencyBlock[],
  decimalsFor: DecimalsFor,
) => {
  const amounts = currencies.map((c) => ({ currency: c.currency, amount: c.total }));
  const converted = consolidateInCurrency(
    amounts,
    displayCurrency,
    await deps.currencyRates.list(),
    deps.clock(),
    deps.rateStaleness,
    decimalsFor(displayCurrency),
  );
  return { displayCurrency, ...converted };
};

export const aggregateSpending = (
  deps: Deps,
  input: ResolvedAggregateSpending,
): ResultAsync<AggregateResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertHasPeriodOrRange(input), aggregateErrors.missingPeriod);

    const { from, to } = resolveDateRange(input);
    const { accountId, categoryId } = yield* resolveAggregateRefs(deps, input);
    const [locale, currencyList] = await Promise.all([deps.locale(), deps.currencies.list()]);
    const decimalsFor = decimalsLookup(currencyList);

    const rows = await deps.transactions.aggregate({
      groupBy: input.groupBy,
      metric: input.metric,
      from,
      to,
      type: input.type ?? null,
      accountId,
      categoryId,
      tagNames: input.tags ?? [],
    });

    const currencies = shapeAggregateResult(rows, input.groupBy, input.sort, locale, decimalsFor, input.limit);
    const result = { groupBy: input.groupBy, metric: input.metric, currencies };
    return ok(
      wantsDisplayConversion(input)
        ? { ...result, converted: await convertBlockTotals(deps, input.displayCurrency, currencies, decimalsFor) }
        : result,
    );
  });
