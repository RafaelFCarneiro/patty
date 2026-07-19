// Transaction core (ADR-016/017, ADR-022 step 3): shell-facing statement-import plumbing. No
// bill/card knowledge, and no account-vs-card ownership decision either — that decision is fixed
// by which aggregate importer built the plan (controllers/creditCard/transaction.ts's
// importCardStatement, controllers/account/transaction.ts's importAccountStatement). Per-line
// defaulting itself (`defaultStatementLines`) is pure data reshaping and lives in
// logic/transaction.ts; this module never touches deps write methods or `Db` — the shell
// (diplomat/mcp, diplomat/http) runs `runEffectsSequence` directly over the plan it builds.

import type { Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { summarizeBulkItems, toBulkItemResult } from '../../logic/transaction.js';
import type { BulkItemResult, BulkResult } from '../../logic/transaction.js';
import type { FlowOutcome } from '../../models/persistable.js';
import type { ClassifiedUpsertResult, DefaultedStatementLine, StatementLine } from '../../models/transaction.js';

/** One line, deferred as a flow the shell can run through `runEffectsSequence` — the same shape
 *  `controllers/deps.ts`'s `RunEffects`/`RunEffectsSequence` already declare, just not invoked here. */
type Flow<T> = () => ResultAsync<FlowOutcome<T>, AppError>;

/**
 * What an aggregate importer hands the shell: every defaulted line, plus how to turn one line into
 * its own single-line flow — unchanged, the same `addCardPurchase`/`addAccountExpense`/
 * `addAccountIncome` the individual tools call. The shell runs `flowFor` through
 * `runEffectsSequence`, one independent unit per line (ADR-022 decision 4) — this module never
 * runs it itself.
 */
export type StatementImportPlan<Line extends StatementLine, T> = {
  lines: readonly DefaultedStatementLine<Line>[];
  flowFor: (line: DefaultedStatementLine<Line>) => Flow<T>;
};

/** Shapes `runEffectsSequence`'s per-line outcomes back into the existing `BulkResult` contract —
 *  duplicate vs. created vs. needs_review comes from each outcome's own idempotency/classification
 *  (rule 6, generalized to per-unit); a failed line's `AppError` becomes that item's error.
 *  `R.zip` pairs each outcome with its own line — the same order `runEffectsSequence` preserves. */
export const buildBulkResult = (
  outcomes: readonly Result<ClassifiedUpsertResult, AppError>[],
  lines: readonly Pick<StatementLine, 'description'>[],
): BulkResult<AppError> => {
  const items: BulkItemResult<AppError>[] = R.pipe(
    R.zip(outcomes, lines),
    R.map(([outcome, line]) => toBulkItemResult(outcome, line.description)),
  );
  return { summary: summarizeBulkItems(items), items };
};
