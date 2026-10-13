import { databaseAheadMessage } from '../models/database.js';

/** Thrown when a database's newest applied migration is newer than the newest this build ships; an entrypoint prints
 *  `message` as is (it is already a complete diagnosis). Shared by `diplomat/db`, which throws it, and the entrypoints
 *  (`main.ts`, `diplomat/cli/commands.ts`), which map it — neither imports the other. */
export class DatabaseAheadError extends Error {
  constructor(version: string) {
    super(databaseAheadMessage(version));
    this.name = 'DatabaseAheadError';
  }
}
