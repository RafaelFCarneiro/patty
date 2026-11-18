import type { Result } from 'neverthrow';
import * as R from 'remeda';
import { BulkItemStatus } from '../models/bulk.js';

/** How one bulk call words its items: what an applied item reports, and what a refused item reports (it is handed the
 *  request item it answers, since an error carries no input of its own). */
export type BulkItemShape<I, V, E, Applied extends object, Refused extends object> = {
  applied: (value: V) => Applied;
  refused: (input: I, error: E) => Refused;
};

/** One item's outcome as `{ status: 'ok', …applied }` or `{ status: 'error', …refused }`. */
export const toBulkItem = <I, V, E, Applied extends object, Refused extends object>(
  input: I,
  outcome: Result<V, E>,
  shape: BulkItemShape<I, V, E, Applied, Refused>,
) =>
  outcome.match(
    (value) => ({ status: BulkItemStatus.enum.ok, ...shape.applied(value) }),
    (error) => ({ status: BulkItemStatus.enum.error, ...shape.refused(input, error) }),
  );

/** Pairs each request item with its outcome, in order. */
export const buildBulkItems = <I, V, E, Applied extends object, Refused extends object>(
  items: readonly I[],
  outcomes: readonly Result<V, E>[],
  shape: BulkItemShape<I, V, E, Applied, Refused>,
) =>
  R.pipe(
    R.zip(items, outcomes),
    R.map(([input, outcome]) => toBulkItem(input, outcome, shape)),
  );
