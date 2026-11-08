import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as KeyLock from '../../../../src/diplomat/db/key-lock.js';
import { acquireKeyLockForTest, keyLockPathForTest } from '../../fixtures/key-lock.js';
import {
  enableWal,
  findEncryptionKey,
  keychainHoldsKey,
  resolveEncryptionKey,
  storeKeychainKeyIfAbsent,
} from '../../../../src/diplomat/db/driver.js';

const keychain = vi.hoisted(() => ({
  loaded: vi.fn(),
  getPassword: vi.fn<() => string | null>(),
  setPassword: vi.fn(),
}));

// The factory runs on first import of the module, so `loaded` records whether it was ever loaded.
vi.mock('@napi-rs/keyring', () => {
  keychain.loaded();
  return {
    Entry: class {
      getPassword = keychain.getPassword;
      setPassword = keychain.setPassword;
    },
  };
});

vi.mock('../../../../src/diplomat/db/key-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof KeyLock>();
  return {
    ...actual,
    withKeyLock: <T>(work: () => Promise<T>, lockPath: string) => actual.withKeyLock(work, lockPath, 150),
  };
});

const FILE_KEY = 'a'.repeat(64);
const ENV_KEY = 'b'.repeat(64);
const DB_PATH = '/unused/fintrack.db';
const KEY_LOCK_PATH = keyLockPathForTest();

describe('resolveEncryptionKey (ADR-032)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-key-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    keychain.loaded.mockClear();
    vi.resetModules();
    keychain.getPassword.mockReset();
    keychain.setPassword.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const keyFile = (contents: string): string => {
    const path = join(tmpDir, 'key');
    writeFileSync(path, contents);
    return path;
  };

  it('reads the key file (trailing newline trimmed) without loading the keychain module', async () => {
    const key = await resolveEncryptionKey({ DB_PATH, FINTRACK_DB_KEY_FILE: keyFile(`${FILE_KEY}\n`) });
    expect(key).toBe(FILE_KEY);
    expect(keychain.loaded).not.toHaveBeenCalled();
  });

  it('prefers the key file over the env var', async () => {
    const key = await resolveEncryptionKey({
      DB_PATH,
      FINTRACK_DB_KEY_FILE: keyFile(FILE_KEY),
      FINTRACK_DB_KEY: ENV_KEY,
    });
    expect(key).toBe(FILE_KEY);
  });

  it('uses the env var when no file is set, without loading the keychain module', async () => {
    const key = await resolveEncryptionKey({ DB_PATH, FINTRACK_DB_KEY: ENV_KEY });
    expect(key).toBe(ENV_KEY);
    expect(keychain.loaded).not.toHaveBeenCalled();
  });

  it('logs which source was used, never the key', async () => {
    await resolveEncryptionKey({ DB_PATH, FINTRACK_DB_KEY_FILE: keyFile(FILE_KEY) });
    await resolveEncryptionKey({ DB_PATH, FINTRACK_DB_KEY: ENV_KEY });
    const logged = vi.mocked(console.warn).mock.calls.map(([message]) => String(message));
    expect(logged[0]).toContain('FINTRACK_DB_KEY_FILE');
    expect(logged[1]).toContain('FINTRACK_DB_KEY from the environment');
    expect(logged.join()).not.toContain(FILE_KEY);
    expect(logged.join()).not.toContain(ENV_KEY);
  });

  it('rejects invalid key file contents with an actionable error', async () => {
    await expect(resolveEncryptionKey({ DB_PATH, FINTRACK_DB_KEY_FILE: keyFile('not-a-key') })).rejects.toThrow(
      /64-character hex.*openssl rand -hex 32/s,
    );
  });

  it('rejects a missing key file with an actionable error', async () => {
    await expect(resolveEncryptionKey({ DB_PATH, FINTRACK_DB_KEY_FILE: join(tmpDir, 'absent') })).rejects.toThrow(
      /cannot read.*openssl rand -hex 32/s,
    );
  });

  it('falls back to the keychain, generating and storing a key on first run', async () => {
    keychain.getPassword.mockReturnValue(null);
    const key = await resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(keychain.setPassword).toHaveBeenCalledWith(key);
  });

  it('returns the existing keychain key', async () => {
    keychain.getPassword.mockReturnValue(FILE_KEY);
    await expect(resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH })).resolves.toBe(FILE_KEY);
  });

  it('rejects a malformed existing keychain entry instead of passing it to libSQL', async () => {
    keychain.getPassword.mockReturnValue('not-a-valid-key');
    await expect(resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH })).rejects.toThrow(
      /keychain is not a 64-character hex key/,
    );
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('fails fast with an actionable error when no source is set and the keychain is unavailable', async () => {
    keychain.getPassword.mockImplementation(() => {
      throw new Error('no secret service');
    });
    await expect(resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH })).rejects.toThrow(
      /keychain.*openssl rand -hex 32.*FINTRACK_DB_KEY_FILE.*FINTRACK_DB_KEY/s,
    );
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('never writes a key file next to the data when resolution fails', async () => {
    const dataDir = join(tmpDir, 'data');
    mkdirSync(dataDir);
    keychain.getPassword.mockImplementation(() => {
      throw new Error('no secret service');
    });

    await expect(resolveEncryptionKey({ DB_PATH: join(dataDir, 'fintrack.db') })).rejects.toThrow();
    await expect(
      resolveEncryptionKey({ DB_PATH: join(dataDir, 'fintrack.db'), FINTRACK_DB_KEY_FILE: join(tmpDir, 'absent') }),
    ).rejects.toThrow();

    expect(readdirSync(dataDir)).toEqual([]);
  });
});

describe('the keychain key helpers (key import)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    keychain.getPassword.mockReset();
    keychain.setPassword.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keychainHoldsKey reads the entry and never writes one', async () => {
    keychain.getPassword.mockReturnValueOnce(null).mockReturnValueOnce(FILE_KEY);
    await expect(keychainHoldsKey()).resolves.toBe(false);
    await expect(keychainHoldsKey()).resolves.toBe(true);
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('storeKeychainKeyIfAbsent writes the key to the entry the server reads when it is empty', async () => {
    keychain.getPassword.mockReturnValue(null);
    await expect(storeKeychainKeyIfAbsent(FILE_KEY, KEY_LOCK_PATH)).resolves.toBe(true);
    expect(keychain.setPassword).toHaveBeenCalledWith(FILE_KEY);
  });

  it('storeKeychainKeyIfAbsent never replaces a key that is there', async () => {
    keychain.getPassword.mockReturnValue(ENV_KEY);
    await expect(storeKeychainKeyIfAbsent(FILE_KEY, KEY_LOCK_PATH)).resolves.toBe(false);
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('generation re-reads the entry under the lock and keeps a key another process wrote meanwhile', async () => {
    keychain.getPassword.mockReturnValueOnce(null).mockReturnValueOnce(ENV_KEY);
    await expect(resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH })).resolves.toBe(ENV_KEY);
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('an import racing a server’s key generation never ends up replacing the server’s key', async () => {
    let stored = null as string | null;
    const events: string[] = [];
    keychain.getPassword.mockImplementation(() => {
      events.push(`get ${stored?.slice(0, 2)}`);
      return stored;
    });
    keychain.setPassword.mockImplementation((value: string) => {
      events.push(`set ${value.slice(0, 2)}`);
      stored = value;
    });
    const [resolved, imported] = await Promise.all([
      resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH }),
      storeKeychainKeyIfAbsent(FILE_KEY, KEY_LOCK_PATH),
    ]);
    const trace = `${events.join(' | ')} || resolved ${resolved.slice(0, 2)} stored ${stored?.slice(0, 2)} imported ${imported}`;
    expect(stored).toBe(resolved);
    expect({ imported, trace }).toEqual({ imported: resolved === FILE_KEY, trace });
  });

  it('surfaces the lock’s own message, not the keychain one, when another process holds the key lock', async () => {
    keychain.getPassword.mockReturnValue(null);
    const held = await acquireKeyLockForTest();
    const resolving = resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH });
    await expect(resolving).rejects.toThrow(/another fintrack process is writing the database key/);
    await expect(resolving).rejects.not.toThrow(/OS keychain/);
    await held.release();
  });

  it('wraps a keychain failure in the keychain message', async () => {
    keychain.getPassword.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    await expect(resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH })).rejects.toThrow(
      /cannot read or write the database encryption key in the OS keychain/,
    );
  });

  it('a server whose keychain already holds a key never waits for the key lock', async () => {
    keychain.getPassword.mockReturnValue(FILE_KEY);
    const held = await acquireKeyLockForTest();
    await expect(resolveEncryptionKey({ DB_PATH, KEY_LOCK_PATH })).resolves.toBe(FILE_KEY);
    await held.release();
  });

  it('findEncryptionKey answers null for an empty keychain instead of generating a key', async () => {
    keychain.getPassword.mockReturnValue(null);
    await expect(findEncryptionKey({ DB_PATH })).resolves.toBeNull();
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('findEncryptionKey follows the server order: file, env, keychain', async () => {
    keychain.getPassword.mockReturnValue(FILE_KEY);
    await expect(findEncryptionKey({ DB_PATH })).resolves.toBe(FILE_KEY);
    await expect(findEncryptionKey({ DB_PATH, FINTRACK_DB_KEY: ENV_KEY })).resolves.toBe(ENV_KEY);
  });

  it('findEncryptionKey rejects a malformed keychain entry', async () => {
    keychain.getPassword.mockReturnValue('not-a-valid-key');
    await expect(findEncryptionKey({ DB_PATH })).rejects.toThrow(/keychain is not a 64-character hex key/);
  });
});

// SQLite refuses WAL for an in-memory database and does not throw — it silently keeps the prior
// journal mode ('memory') and reports it back in the PRAGMA result row. This is the case a bare
// try/catch around the PRAGMA statement misses (see PR #145 review): the fallback warning must be
// driven off the reported mode, not just a thrown exception.
describe('enableWal (ADR-024)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    vi.restoreAllMocks();
  });

  it('warns when SQLite silently keeps a non-WAL mode instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient({ url: ':memory:' });

    await enableWal(client);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WAL journal mode was not applied'));
  });

  it('does not warn when WAL is actually applied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-wal-'));
    const client = createClient({ url: `file:${join(tmpDir, 'wal.db')}` });

    await enableWal(client);

    expect(warn).not.toHaveBeenCalled();
  });
});
