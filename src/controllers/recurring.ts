import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { nextDue, recurringIdempotencyKey } from '../logic/recurring.js'
import { toIsoDate } from '../logic/period.js'
import type { CreateRecurringInput, RecurringRuleView } from '../models/recurring.js'
import type { TransactionView } from '../models/transaction.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCategoryRef } from './resolve.js'

export const listRecurring = (deps: Deps): Promise<RecurringRuleView[]> => deps.recurring.list()

export const createRecurring = (
  deps: Deps,
  input: CreateRecurringInput,
): ResultAsync<RecurringRuleView, AppError> =>
  safeTry(async function* () {
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null

    const rule = await deps.recurring.create(
      {
        id: deps.newId(),
        description: input.description,
        amount: input.amount,
        type: input.type,
        period: input.period,
        nextDue: input.startDate,
        currency: account?.currency ?? input.currency ?? 'BRL',
      },
      { accountId: account?.id ?? null, categoryId: category?.id ?? null },
    )
    return ok(rule)
  })

export type ApplyDueResult = {
  applied: Array<{ rule: string; date: string; transaction: TransactionView }>
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
      const { transaction } = await deps.transactions.create({
        id: deps.newId(),
        description: rule.description,
        amount: rule.amount,
        type: rule.type,
        date: due,
        currency: rule.currency,
        source: 'mcp',
        idempotencyKey: recurringIdempotencyKey(rule.id, due),
        classification: { method: 'user', confidence: 1 },
        refs: { accountId: rule.accountId, categoryId: rule.categoryId },
      })
      applied.push({ rule: rule.description, date: due, transaction })
      due = nextDue(due, rule.period)
    }
    await deps.recurring.advance(rule.id, due)
  }

  return { applied, count: applied.length }
}
