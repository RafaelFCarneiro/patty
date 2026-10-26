import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../../src/composition/boot.js';
import { createDemoShell } from '../../../src/composition/demo.js';
import { seedDemo } from '../../../src/composition/demo-seed.js';
import { demoConfig } from '../../../src/config.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabaseWithKey, type Db } from '../../../src/diplomat/db/driver.js';
import type { DemoShell } from '../../../src/diplomat/cli/io.js';
import { StartupRefusal } from '../../../src/models/error.js';
import { DEMO_DB_KEY, DEMO_PORT, DemoCountry, DemoFailureCode, DemoSeedStatus } from '../../../src/models/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';

const TODAY = new Date(2026, 9, 26, 9);
const OTHER_KEY = 'a'.repeat(64);
const CONFIG = { FIAT_RATE_STALE_HOURS: 24, CRYPTO_RATE_STALE_HOURS: 1 };
const { real_database, not_demo, interrupted, seed_failed, port_in_use } = DemoFailureCode.enum;

let dir: string;
let demoPath: string;
let realPath: string;

const shellWith = (overrides: Parameters<typeof createDemoShell>[0] = {}): DemoShell =>
  createDemoShell({ databasePath: demoPath, realDatabasePath: () => realPath, today: () => TODAY, ...overrides });

const withDb = async <T>(path: string, key: string, work: (db: Db) => Promise<T>): Promise<T> => {
  const db = await openDatabaseWithKey({ DB_PATH: path }, key);
  try {
    return await work(db);
  } finally {
    closeDatabase(db);
  }
};

const scalar = (path: string, query: string, key = DEMO_DB_KEY) =>
  withDb(path, key, async (db) => (await db.all<{ v: string | number | null }>(sql.raw(query)))[0]?.v ?? null);

const kindOf = () => scalar(demoPath, 'SELECT instance_kind AS v FROM settings');
const seededAtOf = () => scalar(demoPath, 'SELECT demo_seeded_at AS v FROM settings');
const accountsOf = () => scalar(demoPath, 'SELECT COUNT(*) AS v FROM accounts');

/** A database at `path`, bootstrapped (so it has the schema) and optionally seeded as a demo. */
const createDatabase = (path: string, key: string, work?: (db: Db) => Promise<unknown>) =>
  withDb(path, key, async (db) => {
    await bootstrap(db);
    await work?.(db);
  });

const demoFiles = () => ['', '-wal', '-shm'].map((suffix) => `${demoPath}${suffix}`);

const failingFirstStep: typeof seedDemo = async (db, options) => {
  await db.run(sql`DELETE FROM categories`);
  return seedDemo(db, options);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-demo-command-'));
  demoPath = join(dir, 'demo.db');
  realPath = join(dir, 'fintrack.db');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('demo — create, reuse, reset', () => {
  it('creates the database with the demo key, seeds it and marks it complete', async () => {
    const prepared = (await shellWith().prepare({ country: DemoCountry.enum.us, reset: false }))._unsafeUnwrap();
    expect(prepared).toEqual({ status: DemoSeedStatus.enum.seeded, databasePath: demoPath, country: 'us' });
    expect(await kindOf()).toBe(InstanceKind.enum.demo);
    expect(await seededAtOf()).toBe(TODAY.toISOString());
    expect(Number(await accountsOf())).toBeGreaterThan(0);
  });

  it('reuses a seeded demo without duplicating anything', async () => {
    const shell = shellWith();
    await shell.prepare({ country: DemoCountry.enum.us, reset: false });
    const before = await accountsOf();
    const again = (await shell.prepare({ country: DemoCountry.enum.us, reset: false }))._unsafeUnwrap();
    expect(again.status).toBe(DemoSeedStatus.enum.present);
    expect(await accountsOf()).toBe(before);
  });

  it('--reset deletes a demo database and seeds it again, here with another country', async () => {
    const shell = shellWith();
    await shell.prepare({ country: DemoCountry.enum.us, reset: false });
    await withDb(demoPath, DEMO_DB_KEY, (db) =>
      db.run(sql`INSERT INTO tags (id, user_id, name, version) VALUES ('t-mine', 'user-owner', 'mine', 0)`),
    );

    const prepared = (await shell.prepare({ country: DemoCountry.enum.br, reset: true }))._unsafeUnwrap();

    expect(prepared).toMatchObject({ status: DemoSeedStatus.enum.seeded, country: 'br' });
    expect(await scalar(demoPath, "SELECT COUNT(*) AS v FROM tags WHERE name = 'mine'")).toBe(0);
    expect(await scalar(demoPath, "SELECT locale AS v FROM user_settings WHERE user_id = 'user-owner'")).toBe('pt');
    expect(await seededAtOf()).toBe(TODAY.toISOString());
  });

  it('--reset on a path that does not exist yet just creates it', async () => {
    const prepared = (await shellWith().prepare({ country: DemoCountry.enum.mx, reset: true }))._unsafeUnwrap();
    expect(prepared.status).toBe(DemoSeedStatus.enum.seeded);
  });

  it('picks the country from the OS locale when none is given', async () => {
    vi.stubEnv('LC_ALL', 'es_CO.UTF-8');
    const prepared = (await shellWith().prepare({ reset: false }))._unsafeUnwrap();
    expect(prepared.country).toBe(DemoCountry.enum.co);
    expect(await scalar(demoPath, "SELECT base_currency AS v FROM user_settings WHERE user_id = 'user-owner'")).toBe(
      'COP',
    );
  });

  it('seeds an empty database that was created but never marked, instead of refusing it', async () => {
    await createDatabase(demoPath, DEMO_DB_KEY);
    const prepared = (await shellWith().prepare({ country: DemoCountry.enum.us, reset: false }))._unsafeUnwrap();
    expect(prepared.status).toBe(DemoSeedStatus.enum.seeded);
    expect(await kindOf()).toBe(InstanceKind.enum.demo);
  });
});

describe('demo — safety: it never touches what is not a demo database', () => {
  const untouched = (path: string) => {
    const before = readFileSync(path);
    return () => {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).equals(before)).toBe(true);
    };
  };

  it.each([false, true])('refuses the real DB_PATH itself (reset=%s) without opening it', async (reset) => {
    await createDatabase(realPath, OTHER_KEY);
    const check = untouched(realPath);
    const shell = shellWith({ databasePath: realPath });
    expect((await shell.prepare({ country: DemoCountry.enum.us, reset }))._unsafeUnwrapErr().code).toBe(real_database);
    check();
  });

  it('refuses the real DB_PATH reached through a symlink', async () => {
    await createDatabase(realPath, OTHER_KEY);
    const check = untouched(realPath);
    symlinkSync(realPath, demoPath);
    expect((await shellWith().prepare({ country: DemoCountry.enum.us, reset: true }))._unsafeUnwrapErr().code).toBe(
      real_database,
    );
    check();
  });

  it.each([false, true])('refuses a database under another key (reset=%s) and leaves it as it was', async (reset) => {
    await createDatabase(demoPath, OTHER_KEY);
    const check = untouched(demoPath);
    expect((await shellWith().prepare({ country: DemoCountry.enum.us, reset }))._unsafeUnwrapErr().code).toBe(not_demo);
    check();
  });

  it.each([false, true])('refuses a file that is not a database (reset=%s) and leaves it as it was', async (reset) => {
    writeFileSync(demoPath, 'my notes, not a database');
    const check = untouched(demoPath);
    expect((await shellWith().prepare({ country: DemoCountry.enum.us, reset }))._unsafeUnwrapErr().code).toBe(not_demo);
    check();
  });

  describe('a standard database that opens with the demo key', () => {
    beforeEach(async () => {
      await createDatabase(demoPath, DEMO_DB_KEY, async (db) => {
        await seedDemo(db, { country: DemoCountry.enum.us, today: TODAY, config: CONFIG });
        await db.run(sql`UPDATE settings SET instance_kind = 'standard' WHERE id = 'singleton'`);
      });
    });

    it('is not seeded over when it holds data', async () => {
      const before = await accountsOf();
      expect((await shellWith().prepare({ reset: false }))._unsafeUnwrapErr().code).toBe(not_demo);
      expect(await accountsOf()).toBe(before);
      expect(await kindOf()).toBe(InstanceKind.enum.standard);
    });

    it('is never deleted by --reset', async () => {
      const before = await accountsOf();
      expect((await shellWith().prepare({ reset: true }))._unsafeUnwrapErr().code).toBe(not_demo);
      expect(await accountsOf()).toBe(before);
    });
  });
});

describe('demo — a seed that does not finish', () => {
  it('removes a database this run created when its first seed fails, and a later run starts clean', async () => {
    const failed = (
      await shellWith({ seed: failingFirstStep }).prepare({ country: DemoCountry.enum.us, reset: false })
    )._unsafeUnwrapErr();

    expect(failed.code).toBe(seed_failed);
    expect(failed.reason).toContain('demo seed failed at');
    expect(demoFiles().some((file) => existsSync(file))).toBe(false);

    const retried = (await shellWith().prepare({ country: DemoCountry.enum.us, reset: false }))._unsafeUnwrap();
    expect(retried.status).toBe(DemoSeedStatus.enum.seeded);
  });

  it('removes it when the seed throws, and still throws', async () => {
    const throwing: typeof seedDemo = async () => {
      throw new Error('disk gone');
    };
    await expect(shellWith({ seed: throwing }).prepare({ country: DemoCountry.enum.us, reset: false })).rejects.toThrow(
      'disk gone',
    );
    expect(demoFiles().some((file) => existsSync(file))).toBe(false);
  });

  it('removes the database a --reset recreated when that seed fails', async () => {
    await shellWith().prepare({ country: DemoCountry.enum.us, reset: false });
    const failed = await shellWith({ seed: failingFirstStep }).prepare({ country: DemoCountry.enum.us, reset: true });
    expect(failed._unsafeUnwrapErr().code).toBe(seed_failed);
    expect(existsSync(demoPath)).toBe(false);
  });

  it('keeps a database that was already there; next run says interrupted, and --reset is the way out', async () => {
    await createDatabase(demoPath, DEMO_DB_KEY);
    const failed = await shellWith({ seed: failingFirstStep }).prepare({ country: DemoCountry.enum.us, reset: false });
    expect(failed._unsafeUnwrapErr().code).toBe(seed_failed);
    expect(existsSync(demoPath)).toBe(true);

    const found = await shellWith().prepare({ country: DemoCountry.enum.us, reset: false });
    expect(found._unsafeUnwrapErr().code).toBe(interrupted);
    expect(await seededAtOf()).toBeNull();

    const reset = (await shellWith().prepare({ country: DemoCountry.enum.us, reset: true }))._unsafeUnwrap();
    expect(reset.status).toBe(DemoSeedStatus.enum.seeded);
    expect(await seededAtOf()).toBe(TODAY.toISOString());
  });

  it('reports a demo found without its completion marker as interrupted, never as already seeded', async () => {
    await shellWith().prepare({ country: DemoCountry.enum.us, reset: false });
    await withDb(demoPath, DEMO_DB_KEY, (db) => db.run(sql`UPDATE settings SET demo_seeded_at = NULL`));
    expect((await shellWith().prepare({ reset: false }))._unsafeUnwrapErr().code).toBe(interrupted);
  });
});

describe('demo — serving', () => {
  it('a taken port is reported as such, not thrown', async () => {
    await shellWith().prepare({ country: DemoCountry.enum.us, reset: false });
    const occupant: Server = createServer();
    await new Promise<void>((resolve) => {
      occupant.once('error', () => resolve());
      occupant.listen(DEMO_PORT, '127.0.0.1', () => resolve());
    });
    try {
      expect((await shellWith().serve())._unsafeUnwrapErr().code).toBe(port_in_use);
    } finally {
      await new Promise((resolve) => occupant.close(resolve));
    }
  });

  it('a process told to open the demo refuses a database that is not one, and says how to create it', async () => {
    await createDatabase(demoPath, DEMO_DB_KEY);
    await expect(boot(demoConfig(demoPath))).rejects.toThrow(StartupRefusal);
    await expect(boot(demoConfig(demoPath))).rejects.toThrow(/demo$/);
  });

  it('opens a seeded demo with the demo key and no login', async () => {
    await shellWith().prepare({ country: DemoCountry.enum.us, reset: false });
    const booted = (await boot(demoConfig(demoPath)))._unsafeUnwrap();
    expect(booted.prepared.stdio).toBeNull();
    closeDatabase(booted.db);
  });
});
