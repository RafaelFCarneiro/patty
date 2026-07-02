import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env['FINTRACK_DB_KEY'];
  delete process.env['FINTRACK_LOCALE'];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfig', () => {
  it('accepts a 64-character hex FINTRACK_DB_KEY', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(64);
    expect(() => loadConfig()).not.toThrow();
  });

  it('accepts uppercase hex characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'A'.repeat(64);
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects a key shorter than 64 characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(63);
    expect(() => loadConfig()).toThrow();
  });

  it('rejects a key longer than 64 characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(65);
    expect(() => loadConfig()).toThrow();
  });

  it('rejects non-hex characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'g'.repeat(64);
    expect(() => loadConfig()).toThrow();
  });

  it('allows FINTRACK_DB_KEY to be omitted (falls back to keychain)', () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it('default DB_PATH is an absolute path inside the home directory', () => {
    delete process.env['DB_PATH'];
    const config = loadConfig();
    expect(isAbsolute(config.DB_PATH)).toBe(true);
    expect(config.DB_PATH.startsWith(homedir())).toBe(true);
  });

  it('DB_PATH env override is respected', () => {
    process.env['DB_PATH'] = '/custom/path/my.db';
    const config = loadConfig();
    expect(config.DB_PATH).toBe('/custom/path/my.db');
  });

  it('rejects a relative DB_PATH override', () => {
    process.env['DB_PATH'] = 'relative/path/my.db';
    expect(() => loadConfig()).toThrow();
  });

  it('rejects a tilde-prefixed DB_PATH override', () => {
    process.env['DB_PATH'] = '~/.fintrack/fintrack.db';
    expect(() => loadConfig()).toThrow();
  });

  it('accepts valid FINTRACK_LOCALE values (en, es, pt)', () => {
    for (const locale of ['en', 'es', 'pt']) {
      process.env['FINTRACK_LOCALE'] = locale;
      expect(loadConfig().FINTRACK_LOCALE).toBe(locale);
    }
  });

  it('rejects invalid FINTRACK_LOCALE values', () => {
    process.env['FINTRACK_LOCALE'] = 'fr';
    expect(() => loadConfig()).toThrow();
  });

  it('allows FINTRACK_LOCALE to be omitted', () => {
    const config = loadConfig();
    expect(config.FINTRACK_LOCALE).toBeUndefined();
  });

  it('FINTRACK_HTTP defaults to false when omitted', () => {
    delete process.env['FINTRACK_HTTP'];
    expect(loadConfig().FINTRACK_HTTP).toBe(false);
  });

  it('FINTRACK_HTTP is true only for the literal string "true"', () => {
    process.env['FINTRACK_HTTP'] = 'true';
    expect(loadConfig().FINTRACK_HTTP).toBe(true);

    process.env['FINTRACK_HTTP'] = '1';
    expect(loadConfig().FINTRACK_HTTP).toBe(false);

    process.env['FINTRACK_HTTP'] = 'false';
    expect(loadConfig().FINTRACK_HTTP).toBe(false);
  });
});
