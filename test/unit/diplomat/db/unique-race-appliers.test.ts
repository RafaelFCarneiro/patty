import { LibsqlError } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { uniqueViolationAsConflict, VersionConflict, type EntityApplier } from '../../../../src/diplomat/db/effects.js';
import { clientGrantApplier } from '../../../../src/diplomat/db/repos/client-grants.js';
import { assetPriceApplier } from '../../../../src/diplomat/db/repos/asset-prices.js';
import { assetApplier } from '../../../../src/diplomat/db/repos/assets.js';
import { currencyRateApplier } from '../../../../src/diplomat/db/repos/currency-rates.js';
import { investmentEventApplier } from '../../../../src/diplomat/db/repos/investments.js';
import { dashboardApplier } from '../../../../src/diplomat/db/repos/dashboards.js';
import { txFailing } from './fake-tx.js';

const unique = () => new LibsqlError('UNIQUE constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE');
const row = { id: 'row-1', version: 0 };

describe('appliers that turn a secondary-UNIQUE race into a VersionConflict', () => {
  it.each([
    ['client grant insert', (tx: never) => clientGrantApplier.insert(tx, row, undefined)],
    ['dashboard insert', (tx: never) => dashboardApplier('user-1').insert(tx, row, undefined)],
    ['dashboard update', (tx: never) => dashboardApplier('user-1').update(tx, row)],
    ['asset insert', (tx: never) => assetApplier.insert(tx, row, undefined)],
    ['asset price insert', (tx: never) => assetPriceApplier.insert(tx, row, undefined)],
    ['currency rate insert', (tx: never) => currencyRateApplier.insert(tx, row, undefined)],
    ['investment event insert', (tx: never) => investmentEventApplier('user-1').insert(tx, row, 'key')],
  ])('%s: a unique violation is a VersionConflict', async (_name, run) => {
    await expect(run(txFailing(unique()))).rejects.toBeInstanceOf(VersionConflict);
  });

  it.each([
    ['client grant insert', (tx: never) => clientGrantApplier.insert(tx, row, undefined)],
    ['dashboard insert', (tx: never) => dashboardApplier('user-1').insert(tx, row, undefined)],
    ['dashboard update', (tx: never) => dashboardApplier('user-1').update(tx, row)],
    ['asset insert', (tx: never) => assetApplier.insert(tx, row, undefined)],
    ['asset price insert', (tx: never) => assetPriceApplier.insert(tx, row, undefined)],
    ['currency rate insert', (tx: never) => currencyRateApplier.insert(tx, row, undefined)],
    ['investment event insert', (tx: never) => investmentEventApplier('user-1').insert(tx, row, 'key')],
  ])('%s: any other failure propagates as it was', async (_name, run) => {
    const failure = new Error('disk I/O error');

    await expect(run(txFailing(failure))).rejects.toBe(failure);
  });
});

describe('uniqueViolationAsConflict', () => {
  const inserting = (insert: EntityApplier['insert']): EntityApplier => ({
    insert,
    update: async () => ({ applied: true }),
    delete: async () => ({ applied: true }),
    check: async () => ({ applied: true }),
  });

  it('turns a unique violation on insert into a VersionConflict, so the engine retries the flow', async () => {
    const wrapped = uniqueViolationAsConflict(
      inserting(async () => {
        throw unique();
      }),
    );
    await expect(wrapped.insert(txFailing(unique()), row, undefined)).rejects.toBeInstanceOf(VersionConflict);
  });

  it('sees a unique violation through a wrapping error, as drizzle reports it', async () => {
    const wrapped = uniqueViolationAsConflict(
      inserting(async () => {
        throw new Error('query failed', { cause: unique() });
      }),
    );
    await expect(wrapped.insert(txFailing(unique()), row, undefined)).rejects.toBeInstanceOf(VersionConflict);
  });

  it('lets any other error through untouched', async () => {
    const failure = new Error('disk I/O error');
    const wrapped = uniqueViolationAsConflict(
      inserting(async () => {
        throw failure;
      }),
    );
    await expect(wrapped.insert(txFailing(failure), row, undefined)).rejects.toBe(failure);
  });

  it('returns what the wrapped insert returns, and passes the key on', async () => {
    const seen: Array<string | undefined> = [];
    const wrapped = uniqueViolationAsConflict(
      inserting(async (_tx, _model, key) => {
        seen.push(key);
        return { applied: true };
      }),
    );
    expect(await wrapped.insert(txFailing(unique()), row, 'key-1')).toEqual({ applied: true });
    expect(seen).toEqual(['key-1']);
  });

  it('leaves update, delete and check as they were', async () => {
    const wrapped = uniqueViolationAsConflict(inserting(async () => ({ applied: true })));
    expect(await wrapped.update(txFailing(unique()), row)).toEqual({ applied: true });
    expect(await wrapped.delete(txFailing(unique()), 'id', 0)).toEqual({ applied: true });
  });
});
