import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { type Db, openDatabase } from '../../../src/diplomat/db/driver.js';
import { currenciesRepo } from '../../../src/diplomat/db/repos/currencies.js';
import { currencies } from '../../../src/diplomat/db/schema.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

const TEST_KEY = 'd'.repeat(64);
const { BRL, USD, MXN, COP, USDC, BTC } = CurrencyCode.enum;

let tmpDir: string;
let db: Db;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-currencies-seed-'));
  db = await openDatabase({
    KEY_LOCK_PATH: keyLockPathForTest(),
    DB_PATH: join(tmpDir, 'seed.db'),
    FINTRACK_DB_KEY: TEST_KEY,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const listCodes = async (): Promise<string[]> => (await currenciesRepo(db).list()).map((c) => c.code);

describe('currency seed (Feature Design 022)', () => {
  it('a fresh database lists MXN and COP with 2 decimals and their prefixed symbols', async () => {
    await bootstrap(db);
    const byCode = Object.fromEntries((await currenciesRepo(db).list()).map((c) => [c.code, c]));
    expect(byCode[MXN]).toEqual({ code: MXN, symbol: 'MX$', name: 'Peso Mexicano', decimals: 2 });
    expect(byCode[COP]).toEqual({ code: COP, symbol: 'COL$', name: 'Peso Colombiano', decimals: 2 });
  });

  it('a database seeded before MXN/COP existed gains both on its next start, leaving the rest untouched', async () => {
    await bootstrap(db);
    const before = await currenciesRepo(db).list();
    await db.delete(currencies).where(inArray(currencies.code, [MXN, COP]));
    expect(await listCodes()).toEqual([BRL, BTC, USD, USDC]);

    await bootstrap(db);

    const after = await currenciesRepo(db).list();
    expect(after).toEqual(before);
    expect(after.map((c) => c.code)).toEqual([BRL, BTC, COP, MXN, USD, USDC]);
  });
});
