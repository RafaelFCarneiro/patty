import type { EngineContext } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { conflict } from '../../models/error.js';
import { createTransactionRunner, type Db, type Tx } from './driver.js';
import { isSqliteBusy } from './sqlite-errors.js';

export const createEngineContext = (
  db: Db,
  onPublishError?: (cause: unknown) => void,
): EngineContext<Tx, AppError> => ({
  runner: createTransactionRunner(db),
  isTransientContention: isSqliteBusy,
  conflictError: () => conflict,
  onPublishError,
});
