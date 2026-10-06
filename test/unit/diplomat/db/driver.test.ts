import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableWal, resolveEncryptionKey } from '../../../../src/diplomat/db/driver.js';

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

const FILE_KEY = 'a'.repeat(64);
const ENV_KEY = 'b'.repeat(64);
const DB_PATH = '/unused/fintrack.db';

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
    const key = await resolveEncryptionKey({ DB_PATH });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(keychain.setPassword).toHaveBeenCalledWith(key);
  });

  it('returns the existing keychain key', async () => {
    keychain.getPassword.mockReturnValue(FILE_KEY);
    await expect(resolveEncryptionKey({ DB_PATH })).resolves.toBe(FILE_KEY);
  });

  it('rejects a malformed existing keychain entry instead of passing it to libSQL', async () => {
    keychain.getPassword.mockReturnValue('not-a-valid-key');
    await expect(resolveEncryptionKey({ DB_PATH })).rejects.toThrow(/keychain is not a 64-character hex key/);
    expect(keychain.setPassword).not.toHaveBeenCalled();
  });

  it('fails fast with an actionable error when no source is set and the keychain is unavailable', async () => {
    keychain.getPassword.mockImplementation(() => {
      throw new Error('no secret service');
    });
    await expect(resolveEncryptionKey({ DB_PATH })).rejects.toThrow(
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
