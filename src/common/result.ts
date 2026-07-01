import { err, ok, type Result } from 'neverthrow';
import type { AppError } from './errors.js';

/** Lift a nullable into Result — `yield* okOr(maybe, error)` in safeTry pipelines. */
export const okOr = <T>(value: T | null | undefined, error: AppError): Result<T, AppError> =>
  value != null ? ok(value) : err(error);

/** Declarative precondition — `yield* guard(cond, error)` short-circuits when violated. */
export const guard = (condition: boolean, error: AppError): Result<void, AppError> =>
  condition ? ok(undefined) : err(error);
