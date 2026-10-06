import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../src/common/net.js';
import { loadConfig } from '../../src/config.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env['FINTRACK_DB_KEY'];
  delete process.env['FINTRACK_DB_KEY_FILE'];
  delete process.env['HOST'];
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

  it('FINTRACK_HTTP defaults to true when omitted (ADR-013 Decision 7 — on by default)', () => {
    delete process.env['FINTRACK_HTTP'];
    expect(loadConfig().FINTRACK_HTTP).toBe(true);
  });

  it('FINTRACK_HTTP is false only for the literal string "false" (opt-out)', () => {
    process.env['FINTRACK_HTTP'] = 'false';
    expect(loadConfig().FINTRACK_HTTP).toBe(false);

    process.env['FINTRACK_HTTP'] = 'true';
    expect(loadConfig().FINTRACK_HTTP).toBe(true);

    // Any other value — including a falsy-looking one like '0' — does not opt out, since only
    // the exact string 'false' does. This keeps the on-by-default posture from being silently
    // undone by an unrelated or malformed env value.
    process.env['FINTRACK_HTTP'] = '0';
    expect(loadConfig().FINTRACK_HTTP).toBe(true);
  });

  it('default PORT is not a common Node/Fastify dev-server port (3000/3001/8080/etc)', () => {
    delete process.env['PORT'];
    const config = loadConfig();
    expect(config.PORT).toBe(51737);
    expect([3000, 3001, 4000, 5000, 8000, 8080]).not.toContain(config.PORT);
  });

  it('PORT env override is respected', () => {
    process.env['PORT'] = '4000';
    expect(loadConfig().PORT).toBe(4000);
  });

  it('FIAT_RATE_STALE_HOURS defaults to 24 when omitted', () => {
    delete process.env['FIAT_RATE_STALE_HOURS'];
    expect(loadConfig().FIAT_RATE_STALE_HOURS).toBe(24);
  });

  it('FIAT_RATE_STALE_HOURS env override is respected', () => {
    process.env['FIAT_RATE_STALE_HOURS'] = '12';
    expect(loadConfig().FIAT_RATE_STALE_HOURS).toBe(12);
  });

  it('FIAT_RATE_STALE_HOURS rejects a non-positive value', () => {
    process.env['FIAT_RATE_STALE_HOURS'] = '0';
    expect(() => loadConfig()).toThrow();
  });

  it('CRYPTO_RATE_STALE_HOURS defaults to 1 when omitted', () => {
    delete process.env['CRYPTO_RATE_STALE_HOURS'];
    expect(loadConfig().CRYPTO_RATE_STALE_HOURS).toBe(1);
  });

  it('CRYPTO_RATE_STALE_HOURS env override is respected', () => {
    process.env['CRYPTO_RATE_STALE_HOURS'] = '0.5';
    expect(loadConfig().CRYPTO_RATE_STALE_HOURS).toBe(0.5);
  });

  it('CRYPTO_RATE_STALE_HOURS rejects a negative value', () => {
    process.env['CRYPTO_RATE_STALE_HOURS'] = '-1';
    expect(() => loadConfig()).toThrow();
  });

  it('HOST defaults to loopback when omitted', () => {
    expect(loadConfig().HOST).toBe(LOOPBACK_HOST);
  });

  it('HOST env override is respected', () => {
    process.env['HOST'] = '0.0.0.0';
    expect(loadConfig().HOST).toBe('0.0.0.0');
  });

  it('rejects an empty HOST', () => {
    process.env['HOST'] = '';
    expect(() => loadConfig()).toThrow();
  });

  it('accepts an absolute FINTRACK_DB_KEY_FILE', () => {
    process.env['FINTRACK_DB_KEY_FILE'] = '/run/secrets/fintrack_db_key';
    expect(loadConfig().FINTRACK_DB_KEY_FILE).toBe('/run/secrets/fintrack_db_key');
  });

  it('rejects a relative FINTRACK_DB_KEY_FILE', () => {
    process.env['FINTRACK_DB_KEY_FILE'] = 'secrets/key';
    expect(() => loadConfig()).toThrow(/absolute path/);
  });

  it('rejects FINTRACK_DB_KEY and FINTRACK_DB_KEY_FILE set together (ambiguous source)', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(64);
    process.env['FINTRACK_DB_KEY_FILE'] = '/run/secrets/fintrack_db_key';
    expect(() => loadConfig()).toThrow(/ambiguous/);
  });
});
