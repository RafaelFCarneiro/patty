import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { pickClassification } from '../logic/classify.js';
import { normalizeMerchant, withMerchant } from '../logic/merchant.js';
import * as persistence from '../logic/persistence.js';
import {
  MAX_RECURRING_OCCURRENCES_PER_RUN,
  nextDue,
  recurringIdempotencyKey,
  withPeriodLabel,
} from '../logic/recurring.js';
import { toIsoDate } from '../logic/period.js';
import { resolveCurrency } from '../logic/money.js';
import { defaultStatusFor, viewFromOutcome } from '../logic/transaction.js';
import {
  RECURRING_ENTITY_TAG,
  type CreateRecurring,
  type RecurringRule,
  type RecurringRuleEntity,
  type RecurringRuleView,
} from '../models/recurring.js';
import { type FlowOutcome, type Persistable, type PersistOutcome } from '@rafaelfcarneiro/effect-runner';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  TransactionSource,
  type TransactionEntity,
  type TransactionView,
} from '../models/transaction.js';
import type { Deps } from './deps.js';
import { resolveAccountRef, resolveCategoryRef } from './resolve.js';

export const listRecurring = async (deps: Deps): Promise<RecurringRuleView[]> => {
  const [locale, rules] = await Promise.all([deps.locale(), deps.recurring.list()]);
  return rules.map(withPeriodLabel(locale));
};

/** No read-back needed — the response is built from the same model plus the already-resolved
 *  account/category names (rule 6). */
export const createRecurring = (
  deps: Deps,
  input: CreateRecurring,
): ResultAsync<FlowOutcome<RecurringRuleView>, AppError> =>
  safeTry(async function* () {
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    // Explicit `merchant` is stored as-is (the user's own naming, no lookup). Otherwise mirror
    // `planAccountMovement`'s precedence — an already-learned `merchant_category` key wins over a
    // fresh normalize, so the rule matches the identity a transaction would.
    const normalizedDescription = normalizeMerchant(input.description);
    const merchantKey = input.merchant
      ? normalizeMerchant(input.merchant) || undefined
      : (pickClassification(await deps.merchants.matchCandidates(normalizedDescription)).merchantKey ??
        (normalizedDescription || undefined));

    const rule: RecurringRule = {
      id: deps.newId(),
      description: input.description,
      amount: input.amount,
      type: input.type,
      period: input.period,
      nextDue: input.startDate,
      currency: resolveCurrency(account, input),
      accountId: account?.id,
      categoryId: category?.id,
      merchantKey,
    };

    const persist = withMerchant(
      [persistence.insert({ entity: RECURRING_ENTITY_TAG, model: rule })],
      rule.merchantKey,
    );
    const response: RecurringRuleView = {
      ...rule,
      accountName: account?.name,
      categoryName: category?.name,
    };
    return ok({ persist, response });
  });

export type ApplyDueResult = {
  applied: Array<{ rule: string; date: string; transaction: TransactionView }>;
  count: number;
};

type RulePlan = {
  occurrences: Array<{ rule: string; date: string; persistable: Persistable }>;
  advance: Persistable;
};

/** `rule.merchantKey`'s `merchants` row was already emitted when the rule was created (`withMerchant`
 *  in `createRecurring`), so occurrences just reference it — no merchant `Persistable` needed here. */
const buildOccurrenceEntity = (
  deps: Deps,
  rule: RecurringRuleEntity,
  due: string,
  today: string,
): TransactionEntity => ({
  id: deps.newId(),
  description: rule.description,
  amount: rule.amount,
  type: rule.type,
  status: defaultStatusFor(due, today),
  date: due,
  currency: rule.currency,
  source: TransactionSource.enum.mcp,
  classification: { method: ClassificationMethod.enum.user, confidence: 1 },
  refs: { accountId: rule.accountId, categoryId: rule.categoryId, merchantKey: rule.merchantKey },
});

/** `advance`'s model carries the rule's full desired end-state, not just `nextDue`, so the shell's
 *  generic versioned update can apply it (rule 3/4). Always advances, even when no new occurrence
 *  gets inserted (an idempotent replay). */
const planRule = (deps: Deps, rule: RecurringRuleEntity, through: string, today: string): RulePlan => {
  const occurrences: RulePlan['occurrences'] = [];
  let due = rule.nextDue;
  for (let i = 0; i < MAX_RECURRING_OCCURRENCES_PER_RUN && due <= through; i++) {
    occurrences.push({
      rule: rule.description,
      date: due,
      persistable: persistence.insert({
        entity: TRANSACTION_ENTITY_TAG,
        model: buildOccurrenceEntity(deps, rule, due, today),
        idempotencyKey: recurringIdempotencyKey(rule.id, due),
      }),
    });
    due = nextDue(due, rule.period);
  }
  const advance = persistence.update({ entity: RECURRING_ENTITY_TAG, model: { ...rule, nextDue: due } });
  return { occurrences, advance };
};

/**
 * Materialize every rule due on/before `through` (default: today). Past/present occurrences land
 * effective; future ones land pending — via defaultStatusFor. Passing a future `through` pre-creates
 * upcoming salary/rent/subscriptions as pending, feeding projections without any extra monthly
 * effort. Idempotent: safe to re-run.
 *
 * Every due rule's occurrences and `advance` apply as one atomic batch: a conflict retries the
 * whole run, which is safe because `recurringIdempotencyKey`'s `rec-<ruleId>-<date>` keys make
 * re-materialization a no-op — already-created occurrences don't duplicate.
 */
export const applyDueRecurring = (
  deps: Deps,
  options?: { through?: string },
): ResultAsync<FlowOutcome<ApplyDueResult>, AppError> =>
  safeTry(async function* () {
    const today = toIsoDate(deps.clock());
    const through = options?.through ?? today;
    const locale = await deps.locale();

    const plans = (await deps.recurring.due(through)).map((rule) => planRule(deps, rule, through, today));
    const occurrences = plans.flatMap((p) => p.occurrences);
    const persist: Persistable[] = [...occurrences.map((o) => o.persistable), ...plans.map((p) => p.advance)];

    const response = (outcomes: PersistOutcome[]): ApplyDueResult => {
      const applied = R.pipe(
        R.zip(occurrences, outcomes.slice(0, occurrences.length)),
        R.filter(([, outcome]) => outcome.applied),
        R.map(([occurrence, outcome]) => ({
          rule: occurrence.rule,
          date: occurrence.date,
          transaction: viewFromOutcome(outcome, locale),
        })),
      );
      return { applied, count: applied.length };
    };

    return ok({ persist, response });
  });
