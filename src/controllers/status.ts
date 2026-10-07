import * as R from 'remeda';
import { Locale } from '../models/locale.js';
import type { HealthOut, StatusOut } from '../wire/out/status.js';
import type { Deps } from './deps.js';

const databaseState = async (deps: Deps): Promise<StatusOut['db']> =>
  (await deps.health.reachable()) ? 'ok' : 'error';

/** The public probe (ADR-033 §6): liveness plus the database check, nothing else. */
export const getHealth = async (deps: Deps): Promise<HealthOut> => ({ status: 'ok', db: await databaseState(deps) });

export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> =>
  R.pipe(await Promise.all([databaseState(deps), deps.locale().catch(R.constant(Locale.enum.en))]), ([db, locale]) => ({
    name: 'fintrack',
    version,
    db,
    locale,
  }));
