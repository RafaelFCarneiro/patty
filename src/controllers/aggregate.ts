import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { shapeAggregateResult } from '../logic/aggregate.js'
import { assertHasPeriodOrRange, resolveDateRange } from '../logic/period.js'
import { aggregateErrors, type ResolvedAggregateSpending } from '../models/aggregate.js'
import type { AggregateResult } from '../models/aggregate.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCategoryRef } from './resolve.js'

export const aggregateSpending = (
  deps: Deps,
  input: ResolvedAggregateSpending,
): ResultAsync<AggregateResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertHasPeriodOrRange(input), aggregateErrors.missingPeriod)

    const { from, to } = resolveDateRange(input)

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null

    const locale = await deps.locale()

    const rows = await deps.transactions.aggregate({
      groupBy: input.groupBy,
      metric: input.metric,
      sort: input.sort,
      limit: input.limit,
      from,
      to,
      type: input.type ?? null,
      accountId: account?.id ?? null,
      categoryId: category?.id ?? null,
      tagNames: input.tags ?? [],
    })

    const currencies = shapeAggregateResult(rows, input.groupBy, input.sort, locale)

    return ok({
      groupBy: input.groupBy,
      metric: input.metric,
      currencies,
    })
  })
