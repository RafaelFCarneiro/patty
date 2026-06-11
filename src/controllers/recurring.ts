import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { nextDue, recurringIdempotencyKey } from '../logic/recurring.js'
import { toIsoDate } from '../logic/period.js'
import { resolveByName } from '../logic/resolve.js'
import type { CreateRecurringInput, RecurringRule } from '../models/recurring.js'
import type { Transaction } from '../models/transaction.js'
import type { Deps } from './deps.js'

export const listRecurring = (deps: Deps): Promise<RecurringRule[]> => deps.recurring.list()

export const createRecurring = async (
  deps: Deps,
  input: CreateRecurringInput,
): Promise<Result<RecurringRule, AppError>> => {
  let accountId: string | null = null
  let currency = input.currency ?? 'BRL'
  if (input.account) {
    const res = resolveByName(await deps.accounts.list(), input.account)
    if (res.kind === 'none')
      return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
    accountId = res.entity.id
    currency = res.entity.currency
  }

  let categoryId: string | null = null
  if (input.category) {
    const res = resolveByName(await deps.categories.list(), input.category)
    if (res.kind === 'none')
      return err({ code: 'unknown_category', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_category', query: res.query, candidates: res.candidates })
    categoryId = res.entity.id
  }

  const rule = await deps.recurring.create(
    {
      id: deps.newId(),
      description: input.description,
      amount: input.amount,
      type: input.type,
      period: input.period,
      nextDue: input.startDate,
      currency,
    },
    { accountId, categoryId },
  )
  return ok(rule)
}

export type ApplyDueResult = {
  applied: Array<{ rule: string; date: string; transaction: Transaction }>
  count: number
}

/** Materialize every rule due on/before today. Idempotent: stable key per rule+date. */
export const applyDueRecurring = async (deps: Deps): Promise<ApplyDueResult> => {
  const today = toIsoDate(deps.clock())
  const applied: ApplyDueResult['applied'] = []

  for (const rule of await deps.recurring.due(today)) {
    let due = rule.nextDue
    // catch up missed periods, bounded to avoid runaway loops on ancient rules
    for (let i = 0; i < 36 && due <= today; i++) {
      const { transaction } = await deps.transactions.create(
        {
          id: deps.newId(),
          description: rule.description,
          amount: rule.amount,
          type: rule.type,
          date: due,
          currency: rule.currency,
          source: 'mcp',
          idempotencyKey: recurringIdempotencyKey(rule.id, due),
          classificationMethod: 'user',
          confidence: 1,
          rawInput: null,
        },
        {
          accountId: rule.accountId ?? null,
          cardId: null,
          categoryId: rule.categoryId ?? null,
          merchantKey: null,
        },
      )
      applied.push({ rule: rule.description, date: due, transaction })
      due = nextDue(due, rule.period)
    }
    await deps.recurring.advance(rule.id, due)
  }

  return { applied, count: applied.length }
}
