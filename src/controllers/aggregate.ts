import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { shapeAggregateResult } from '../logic/aggregate.js'
import { periodRange } from '../logic/period.js'
import type { AggregateResult, AggregateSpending } from '../models/aggregate.js'
import { validation } from '../models/error.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCategoryRef } from './resolve.js'

export const aggregateSpending = (
  deps: Deps,
  input: AggregateSpending & { metric: NonNullable<AggregateSpending['metric']>; sort: NonNullable<AggregateSpending['sort']>; limit: NonNullable<AggregateSpending['limit']> },
): ResultAsync<AggregateResult, AppError> =>
  safeTry(async function* () {
    const hasPeriod = input.month != null && input.year != null
    const hasRange = input.from != null || input.to != null
    yield* guard(
      hasPeriod || hasRange,
      validation(['provide month+year or from/to date range']),
    )

    const range = hasPeriod ? periodRange({ month: input.month!, year: input.year! }) : null
    const from = range?.from ?? input.from ?? null
    const to = range?.to ?? input.to ?? null

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
