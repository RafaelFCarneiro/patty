import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import { shapeAggregateResult } from '../logic/aggregate.js';
import { consolidateInCurrency } from '../logic/currencyRate.js';
import { decimalsLookup } from '../logic/money.js';
import { assertHasPeriodOrRange, resolveDateRange } from '../logic/period.js';
import { AggregateMetric, aggregateErrors, type ResolvedAggregateSpending } from '../models/aggregate.js';
import type { AggregateResult } from '../models/aggregate.js';
import type { Deps } from './deps.js';
import { resolveAccountRef, resolveCategoryRef } from './resolve.js';

/** Converting to `displayCurrency` correlates two aggregates (this read's own per-currency block
 *  totals × `currency_rates`), so it is orchestrated here rather than inside a repo — the
 *  transactions repo returns its own aggregate unchanged, `currencyRatesRepo` returns rates, and
 *  the pure `logic/currencyRate.ts#consolidateInCurrency` correlates them. Only attached for
 *  `metric: 'sum'`: a block total is then a genuine money quantity meaningful to convert and
 *  cross-sum, while `count` is a transaction count and `avg` is a sum of per-group averages,
 *  neither a coherent cross-currency amount. Omitting `displayCurrency` (or requesting count/avg)
 *  keeps the response byte-identical to before this option existed. */
export const aggregateSpending = (
  deps: Deps,
  input: ResolvedAggregateSpending,
): ResultAsync<AggregateResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertHasPeriodOrRange(input), aggregateErrors.missingPeriod);

    const { from, to } = resolveDateRange(input);

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;

    const [locale, currencyList] = await Promise.all([deps.locale(), deps.currencies.list()]);
    const decimalsFor = decimalsLookup(currencyList);

    const rows = await deps.transactions.aggregate({
      groupBy: input.groupBy,
      metric: input.metric,
      from,
      to,
      type: input.type ?? null,
      accountId: account?.id ?? null,
      categoryId: category?.id ?? null,
      tagNames: input.tags ?? [],
    });

    const currencies = shapeAggregateResult(rows, input.groupBy, input.sort, locale, decimalsFor, input.limit);

    if (!input.displayCurrency || input.metric !== AggregateMetric.enum.sum) {
      return ok({ groupBy: input.groupBy, metric: input.metric, currencies });
    }

    const rates = await deps.currencyRates.list();
    const amounts = currencies.map((c) => ({ currency: c.currency, amount: c.total }));
    const converted = consolidateInCurrency(
      amounts,
      input.displayCurrency,
      rates,
      deps.clock(),
      deps.rateStaleness,
      decimalsFor(input.displayCurrency),
    );

    return ok({
      groupBy: input.groupBy,
      metric: input.metric,
      currencies,
      converted: { displayCurrency: input.displayCurrency, ...converted },
    });
  });
