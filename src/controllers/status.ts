import * as R from 'remeda';
import { Locale } from '../models/locale.js';
import type { StatusOut } from '../wire/out/status.js';
import type { Deps } from './deps.js';
import { type DatabaseState, type Health } from '../models/database.js';

const databaseState = async (deps: Pick<Deps, 'health'>): Promise<DatabaseState> =>
  (await deps.health.reachable()) ? 'ok' : 'error';

export const getHealth = async (deps: Pick<Deps, 'health'>): Promise<Health> => ({
  status: 'ok',
  db: await databaseState(deps),
});

export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> =>
  R.pipe(await Promise.all([databaseState(deps), deps.locale().catch(R.constant(Locale.enum.en))]), ([db, locale]) => ({
    name: 'fintrack',
    version,
    db,
    locale,
  }));
