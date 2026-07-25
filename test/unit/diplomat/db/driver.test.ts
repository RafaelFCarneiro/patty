import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableWal } from '../../../../src/diplomat/db/driver.js';

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
