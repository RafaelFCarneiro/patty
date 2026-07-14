// Transaction core (ADR-016/017): generic statement-import runner. No bill/card knowledge, and no
// account-vs-card ownership decision either — that decision is fixed by which aggregate importer
// the caller invoked (controllers/creditCard/transaction.ts's importCardStatement,
// controllers/account/transaction.ts's importAccountStatement), each of which binds its own fixed
// card/account and per-line create function and calls runStatementImport with it. This module only
// defaults per-line fields (date, idempotencyKey) shared by every import, regardless of aggregate —
// it must never import logic/bill.js, touch deps.bills, or make an ownership decision (ADR-017 step
// 2: single-source imports make that decision impossible by construction).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { toIsoDate } from '../../logic/period.js';
import { deriveIdempotencyKey, summarizeBulkItems, toBulkItemResult } from '../../logic/transaction.js';
import type { BulkItemResult, BulkResult } from '../../logic/transaction.js';
import type { ClassifiedUpsertResult, TransactionSource } from '../../models/transaction.js';
import type { Deps } from '../deps.js';

/** Minimal shape every statement line carries, regardless of aggregate — what the runner needs to
 *  default (date, idempotencyKey) before handing the line to the aggregate's own create function. */
export type StatementLine = { date?: string; description: string; amount: number; idempotencyKey?: string };

/** The aggregate's own per-line create function (e.g. addCardPurchase bound to a fixed card, or
 *  the account aggregate's own legacy repo-write path bound to a fixed account — ADR-021 phase 3
 *  still owes bulk import its own FC/IS + idempotency-aware-outcome conversion, so this runner
 *  keeps expecting an already-applied result rather than a `Persistable` batch) — injected so this
 *  module never imports an aggregate. Receives the line with the runner's defaults already applied.
 *  `classification` is required (narrower than `UpsertTransactionResult`'s general optional field):
 *  a statement line is always a movement or card purchase, never a transfer — single-source imports
 *  make routing to a transfer-shaped create function impossible by construction (ADR-017 step 2). */
export type StatementLineCreateFn<Line extends StatementLine> = (
  deps: Deps,
  line: Line & { date: string; idempotencyKey: string; rawInput?: string },
  source: TransactionSource,
) => ResultAsync<ClassifiedUpsertResult, AppError>;

/** Statement paste/import shared by every aggregate importer: each line idempotent, classified,
 *  flagged for review when uncertain. Defaults per-line fields (date, idempotencyKey), then
 *  delegates the whole line to the aggregate's own create function — ownership is fixed by which
 *  importer called this, never decided here. */
export const runStatementImport = <Line extends StatementLine>(
  deps: Deps,
  lines: readonly Line[],
  rawInput: string | undefined,
  source: TransactionSource,
  createLine: StatementLineCreateFn<Line>,
): ResultAsync<BulkResult<AppError>, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();
    const cachedDeps: Deps = { ...deps, locale: () => Promise.resolve(locale) };
    const items: BulkItemResult<AppError>[] = [];
    for (const line of lines) {
      const date = line.date ?? toIsoDate(deps.clock());
      const idempotencyKey = line.idempotencyKey ?? deriveIdempotencyKey({ ...line, date });

      const result = await createLine(cachedDeps, { ...line, date, idempotencyKey, rawInput }, source);

      items.push(toBulkItemResult(result, line.description));
    }

    return ok({ summary: summarizeBulkItems(items), items });
  });
