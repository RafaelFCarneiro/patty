import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { localizeRecurringPeriod, withTransactionLabels } from '../logic/labels.js'
import { nextDue, recurringIdempotencyKey } from '../logic/recurring.js'
import { toIsoDate } from '../logic/period.js'
import type { CreateRecurringInput, RecurringRuleView } from '../models/recurring.js'
import { defaultStatusFor } from '../logic/transaction.js'
import { ClassificationMethod, TransactionSource, type TransactionView } from '../models/transaction.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCategoryRef } from './resolve.js'

export const listRecurring = async (deps: Deps): Promise<RecurringRuleView[]> => {
  const [locale, rules] = await Promise.all([deps.locale(), deps.recurring.list()])
  return rules.map((r) => ({ ...r, periodLabel: localizeRecurringPeriod(r.period, locale) }))
}

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

/**
 * Materialize every rule due on/before `through` (default: today).
 * Past/present occurrences land effective; future ones land pending — via defaultStatusFor.
 * Passing a future `through` pre-creates upcoming salary/rent/subscriptions as pending,
 * feeding projections without any extra monthly effort. Idempotent: safe to re-run.
 */
export const applyDueRecurring = async (
  deps: Deps,
  options?: { through?: string },
): Promise<ApplyDueResult> => {
  const today = toIsoDate(deps.clock())
  const through = options?.through ?? today
  const applied: ApplyDueResult['applied'] = []

  for (const rule of await deps.recurring.due(through)) {
    let due = rule.nextDue
    // bounded loop to prevent runaway on ancient rules
    for (let i = 0; i < 36 && due <= through; i++) {
      const { transaction, created } = await deps.transactions.create({
        id: deps.newId(),
        description: rule.description,
        amount: rule.amount,
        type: rule.type,
        status: defaultStatusFor(due, today),
        date: due,
        currency: rule.currency,
        source: TransactionSource.enum.mcp,
        idempotencyKey: recurringIdempotencyKey(rule.id, due),
        classification: { method: ClassificationMethod.enum.user, confidence: 1 },
        refs: { accountId: rule.accountId, categoryId: rule.categoryId },
      }, [])
      if (created) applied.push({ rule: rule.description, date: due, transaction })
      due = nextDue(due, rule.period)
    }
    await deps.recurring.advance(rule.id, due)
  }

  const locale = await deps.locale()
  const labeled = applied.map((a) => ({
    ...a,
    transaction: withTransactionLabels(a.transaction, locale),
  }))
  return { applied: labeled, count: labeled.length }
}
