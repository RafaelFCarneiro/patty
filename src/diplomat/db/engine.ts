import type { EngineContext } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { conflict } from '../../models/error.js';
import { createTransactionRunner, type Db, type Tx } from './driver.js';
import { isSqliteBusy } from './sqliteErrors.js';

/** The effect runner's context bound to the SQLite adapter and FinTrack's own error — assembled once per process
 *  by whichever composition root opens the database (the server, the CLI). */
export const createEngineContext = (
  db: Db,
  onPublishError?: (cause: unknown) => void,
): EngineContext<Tx, AppError> => ({
  runner: createTransactionRunner(db),
  isTransientContention: isSqliteBusy,
  conflictError: () => conflict,
  onPublishError,
});
