import { LibsqlError } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { VersionConflict } from '../../../../src/diplomat/db/effects.js';
import { clientGrantApplier } from '../../../../src/diplomat/db/repos/client-grants.js';
import { dashboardApplier } from '../../../../src/diplomat/db/repos/dashboards.js';
import { txFailing } from './fake-tx.js';

const unique = () => new LibsqlError('UNIQUE constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE');
const row = { id: 'row-1', version: 0 };

describe('appliers that turn a secondary-UNIQUE race into a VersionConflict', () => {
  it.each([
    ['client grant insert', (tx: never) => clientGrantApplier.insert(tx, row, undefined)],
    ['dashboard insert', (tx: never) => dashboardApplier('user-1').insert(tx, row, undefined)],
    ['dashboard update', (tx: never) => dashboardApplier('user-1').update(tx, row)],
  ])('%s: a unique violation is a VersionConflict', async (_name, run) => {
    await expect(run(txFailing(unique()))).rejects.toBeInstanceOf(VersionConflict);
  });

  it.each([
    ['client grant insert', (tx: never) => clientGrantApplier.insert(tx, row, undefined)],
    ['dashboard insert', (tx: never) => dashboardApplier('user-1').insert(tx, row, undefined)],
    ['dashboard update', (tx: never) => dashboardApplier('user-1').update(tx, row)],
  ])('%s: any other failure propagates as it was', async (_name, run) => {
    const failure = new Error('disk I/O error');

    await expect(run(txFailing(failure))).rejects.toBe(failure);
  });
});
