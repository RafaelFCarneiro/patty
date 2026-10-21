import { eq } from 'drizzle-orm';
import * as setupCodeAdapters from '../../../adapters/setup-codes.js';
import { SETUP_CODE_ID, type SetupCodeEntity } from '../../../models/auth/owner.js';
import type { Db } from '../driver.js';
import { setupCodes } from '../schema.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type SetupCodesRepo = {
  findByHash: (codeHash: string) => Promise<SetupCodeEntity | null>;
  /** The single setup-code row, if one was ever issued. */
  current: () => Promise<SetupCodeEntity | null>;
};

export const setupCodesRepo = (db: Db): SetupCodesRepo => ({
  findByHash: async (codeHash) => {
    const [row] = await db.select().from(setupCodes).where(eq(setupCodes.codeHash, codeHash)).limit(1);
    return row ? setupCodeAdapters.dbToModel(row) : null;
  },

  current: async () => {
    const [row] = await db.select().from(setupCodes).where(eq(setupCodes.id, SETUP_CODE_ID)).limit(1);
    return row ? setupCodeAdapters.dbToModel(row) : null;
  },
});

const versionedSetupCodeApplier = versionedTableApplier(setupCodes);

// Singleton row (`SETUP_CODE_ID`): an id collision on insert IS the concurrent-first-issue race (two starters
// both saw no row). The plain applier would silently no-op the loser, leaving it printing a code that was
// never stored — so, like `settingsApplier`, a collision retries, and the retry updates the winner's row.
export const setupCodeApplier: EntityApplier = {
  ...versionedSetupCodeApplier,
  insert: async (tx, model) => {
    const outcome = await versionedSetupCodeApplier.insert(tx, model);
    if (!outcome.applied) throw new VersionConflict();
    return outcome;
  },
};
