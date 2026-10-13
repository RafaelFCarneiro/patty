import { describe, expect, it } from 'vitest';
import { isDatabaseAhead } from '../../../src/logic/migration.js';
import { NPX_COMMAND, PACKAGE_NAME } from '../../../src/models/auth.js';
import { databaseAheadMessage, STALE_GLOBAL_CHECK_COMMAND } from '../../../src/models/database.js';

const NEWEST_KNOWN = 1_791_571_168_273;

describe('isDatabaseAhead', () => {
  it('is true when the database holds a migration newer than any this build ships', () => {
    expect(isDatabaseAhead(NEWEST_KNOWN + 1, NEWEST_KNOWN)).toBe(true);
  });

  it('is false for a database exactly at this build’s newest migration', () => {
    expect(isDatabaseAhead(NEWEST_KNOWN, NEWEST_KNOWN)).toBe(false);
  });

  it('is false for a database behind this build — it will simply be migrated', () => {
    expect(isDatabaseAhead(NEWEST_KNOWN - 1, NEWEST_KNOWN)).toBe(false);
  });

  it('is false for a fresh database the migrator has never run on', () => {
    expect(isDatabaseAhead(undefined, NEWEST_KNOWN)).toBe(false);
  });
});

describe('databaseAheadMessage', () => {
  const message = databaseAheadMessage('1.2.3');

  it('names the build, says why it stopped, and gives both remedies with pinned commands', () => {
    expect(message).toBe(
      "fintrack: this build (v1.2.3) is older than your database (it has migrations this version doesn't know). " +
        `Update with \`${NPX_COMMAND}\`, or check for a stale global install: \`npm ls -g ${PACKAGE_NAME}\`.`,
    );
    expect(NPX_COMMAND).toBe('npx @rafaelfcarneiro/fintrack@latest');
    expect(STALE_GLOBAL_CHECK_COMMAND).toBe('npm ls -g @rafaelfcarneiro/fintrack');
  });

  it('carries no path and no key', () => {
    expect(message).not.toMatch(/[/\\](?:Users|home|tmp)\b/);
    expect(message).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(message).not.toContain('.db');
  });
});
