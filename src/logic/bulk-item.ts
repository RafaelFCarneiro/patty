import type { Result } from 'neverthrow';
import * as R from 'remeda';
import { BulkItemStatus, type BulkItemShape } from '../models/bulk.js';

export const toBulkItem = <I, V, E, Applied extends object, Refused extends object>(
  input: I,
  outcome: Result<V, E>,
  shape: BulkItemShape<I, V, E, Applied, Refused>,
) =>
  outcome.match(
    (value) => ({ status: BulkItemStatus.enum.ok, ...shape.applied(value) }),
    (error) => ({ status: BulkItemStatus.enum.error, ...shape.refused(input, error) }),
  );

export const buildBulkItems = <I, V, E, Applied extends object, Refused extends object>(
  items: readonly I[],
  outcomes: readonly Result<V, E>[],
  shape: BulkItemShape<I, V, E, Applied, Refused>,
) =>
  R.pipe(
    R.zip(items, outcomes),
    R.map(([input, outcome]) => toBulkItem(input, outcome, shape)),
  );
