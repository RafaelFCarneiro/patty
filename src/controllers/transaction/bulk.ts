// Transaction core (ADR-016): bulk import defaulting. No bill/card knowledge, and no card/account
// routing decision either — must never import logic/bill.js, touch deps.bills, or re-implement the
// account-vs-card dispatch. createTransactionsBulk receives the diplomat composition root's
// single-item router (diplomat/transactionRouting.ts's routeCreateTransaction) as an injected
// callback instead of importing any aggregate: it only defaults per-line fields (date, account/card
// top-level fallback, idempotencyKey) and delegates the actual routing decision to that one
// function — the same one create_transaction itself uses — so the decision lives in exactly one
// place instead of being duplicated here.

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { toIsoDate } from '../../logic/period.js';
import { deriveIdempotencyKey, summarizeBulkItems, toBulkItemResult } from '../../logic/transaction.js';
import type { BulkItemResult, BulkResult } from '../../logic/transaction.js';
import type {
  CreateTransaction,
  CreateTransactionResult,
  CreateTransactionsBulk,
  TransactionSource,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';

/**
 * The composition root's single-item routing decision (`diplomat/transactionRouting.ts`'s
 * `routeCreateTransaction`), injected rather than imported — see module header. Typed purely
 * against the core's own `CreateTransaction`/`CreateTransactionResult`, with no card- or
 * account-shaped fields baked into the signature: the core doesn't need to know a card purchase
 * carries a required `card` field or that an account movement doesn't — it just hands off a fully
 * defaulted line and trusts the injected router to decide.
 */
export type RouteCreateTransactionFn = (
  deps: Deps,
  input: CreateTransaction,
  source: TransactionSource,
) => ResultAsync<CreateTransactionResult, AppError>;

/** Statement paste/import: each line idempotent, classified, flagged for review when uncertain.
 *  Defaults per-line fields (date, account/card top-level fallback, idempotencyKey), then delegates
 *  the whole line to the injected router — the same routing `create_transaction` itself uses, so
 *  account-vs-card dispatch and its exclusivity/bill-assignment guards are decided in one place. */
export const createTransactionsBulk = (
  deps: Deps,
  input: CreateTransactionsBulk,
  source: TransactionSource,
  routeCreateTransaction: RouteCreateTransactionFn,
): ResultAsync<BulkResult<AppError>, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();
    const cachedDeps: Deps = { ...deps, locale: () => Promise.resolve(locale) };
    const items: BulkItemResult<AppError>[] = [];
    for (const item of input.items) {
      const date = item.date ?? toIsoDate(deps.clock());
      const account = item.account ?? input.account;
      const card = item.card ?? input.card;
      const idempotencyKey = item.idempotencyKey ?? deriveIdempotencyKey({ ...item, date });

      const result = await routeCreateTransaction(
        cachedDeps,
        { ...item, date, account, card, idempotencyKey, rawInput: input.rawInput },
        source,
      );

      items.push(toBulkItemResult(result, item.description));
    }

    return ok({ summary: summarizeBulkItems(items), items });
  });
