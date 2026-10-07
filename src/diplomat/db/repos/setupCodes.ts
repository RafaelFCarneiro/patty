import { eq } from 'drizzle-orm';
import * as setupCodeAdapters from '../../../adapters/setupCodes.js';
import type { SetupCodeEntity } from '../../../models/auth.js';
import type { Db } from '../driver.js';
import { setupCodes } from '../schema.js';
import { versionedTableApplier } from '../effects.js';

export type SetupCodesRepo = {
  findByHash: (codeHash: string) => Promise<SetupCodeEntity | null>;
  list: () => Promise<SetupCodeEntity[]>;
};

export const setupCodesRepo = (db: Db): SetupCodesRepo => ({
  findByHash: async (codeHash) => {
    const [row] = await db.select().from(setupCodes).where(eq(setupCodes.codeHash, codeHash)).limit(1);
    return row ? setupCodeAdapters.dbToModel(row) : null;
  },

  list: async () => {
    const rows = await db.select().from(setupCodes);
    return rows.map(setupCodeAdapters.dbToModel);
  },
});

export const setupCodeApplier = versionedTableApplier(setupCodes);
