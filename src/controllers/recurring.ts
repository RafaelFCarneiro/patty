import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { normalizeMerchant, withMerchant } from '../logic/merchant.js';
import * as persistence from '../logic/persistence.js';
import { dueSchedule, newRule, recurringIdempotencyKey, withPeriodLabel } from '../logic/recurring.js';
import { toIsoDate } from '../logic/period.js';
import { defaultStatusFor, viewFromOutcome } from '../logic/transaction.js';
import {
  RECURRING_ENTITY_TAG,
  type CreateRecurring,
  type RecurringRuleEntity,
  type RecurringRuleView,
  type ApplyDueResult,
  type RulePlan,
} from '../models/recurring.js';
import type { FlowOutcome, Persistable, PersistOutcome } from '@rfc0/effect-runner';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  TransactionSource,
  type TransactionEntity,
} from '../models/transaction.js';
import type { Deps } from './deps.js';
import { resolveAccountRef, resolveCategoryRef } from './resolve.js';

export const listRecurring = async (deps: Deps): Promise<RecurringRuleView[]> => {
  const [locale, rules] = await Promise.all([deps.locale(), deps.recurring.list()]);
  return rules.map(withPeriodLabel(locale));
};

export const createRecurring = (
  deps: Deps,
  input: CreateRecurring,
): ResultAsync<FlowOutcome<RecurringRuleView>, AppError> =>
  safeTry(async function* () {
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    const candidates = input.merchant ? [] : await deps.merchants.matchCandidates(normalizeMerchant(input.description));
    const rule = newRule({ id: deps.newId(), input, account, category, candidates });

    const persist = withMerchant([persistence.insert({ entity: RECURRING_ENTITY_TAG, model: rule })], rule.merchantKey);
    const response: RecurringRuleView = {
      ...rule,
      accountName: account?.name,
      categoryName: category?.name,
    };
    return ok({ persist, response });
  });

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

const planRule = (deps: Deps, rule: RecurringRuleEntity, through: string, today: string): RulePlan => {
  const { dates, next } = dueSchedule(rule.nextDue, through, rule.period);
  const occurrences: RulePlan['occurrences'] = dates.map((date) => ({
    rule: rule.description,
    date,
    persistable: persistence.insert({
      entity: TRANSACTION_ENTITY_TAG,
      model: buildOccurrenceEntity(deps, rule, date, today),
      idempotencyKey: recurringIdempotencyKey(rule.id, date),
    }),
  }));
  const advance = persistence.update({ entity: RECURRING_ENTITY_TAG, model: { ...rule, nextDue: next } });
  return { occurrences, advance };
};

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
