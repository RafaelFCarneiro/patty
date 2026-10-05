import type { Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { summarizeBulkItems, toBulkItemResult } from '../../logic/transaction.js';
import type { BulkItemResult, BulkResult } from '../../logic/transaction.js';
import type { FlowOutcome } from '@rfc0/effect-runner';
import type { ClassifiedUpsertResult, DefaultedStatementLine, StatementLine } from '../../models/transaction.js';

type Flow<T> = () => ResultAsync<FlowOutcome<T>, AppError>;

export type StatementImportPlan<Line extends StatementLine, T> = {
  lines: readonly DefaultedStatementLine<Line>[];
  flowFor: (line: DefaultedStatementLine<Line>) => Flow<T>;
};

// outcomes[i] must correspond to lines[i] — runEffectsSequence's return is positional.
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
