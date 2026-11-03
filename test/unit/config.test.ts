import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPV4_WILDCARD_HOST, LOOPBACK_HOST } from '../../src/common/net.js';
import { demoConfig, DEMO_DB_PATH, EncryptionKey, loadConfig, osLocale } from '../../src/config.js';
import { DEMO_DB_KEY, DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT } from '../../src/models/demo/core.js';
import { AuthMode } from '../../src/models/auth/mode.js';

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
    process.env['HOST'] = IPV4_WILDCARD_HOST;
    expect(loadConfig().HOST).toBe(IPV4_WILDCARD_HOST);
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

describe('the demo (FINTRACK_DEMO)', () => {
  it('the published demo key is a valid database key', () => {
    expect(EncryptionKey.safeParse(DEMO_DB_KEY).success).toBe(true);
  });

  it('fixes the key and turns the login off, whatever FINTRACK_AUTH says', () => {
    process.env[DEMO_ENV_VAR] = DEMO_ENV_ON;
    process.env['FINTRACK_AUTH'] = AuthMode.enum.required;
    expect(loadConfig()).toMatchObject({
      FINTRACK_DEMO: true,
      FINTRACK_DB_KEY: DEMO_DB_KEY,
      FINTRACK_AUTH: AuthMode.enum.disabled,
    });
  });

  it('is off unless it is exactly 1, and then changes nothing about the real install', () => {
    process.env[DEMO_ENV_VAR] = 'true';
    delete process.env['FINTRACK_AUTH'];
    const config = loadConfig();
    expect(config.FINTRACK_DEMO).toBe(false);
    expect(config.FINTRACK_DB_KEY).toBeUndefined();
    expect(config.FINTRACK_AUTH).toBe(AuthMode.enum.required);
  });

  it.each([
    ['FINTRACK_DB_KEY', 'a'.repeat(64)],
    ['FINTRACK_DB_KEY_FILE', '/run/secrets/key'],
  ])('refuses to be combined with %s: the demo key is not a choice', (name, value) => {
    process.env[DEMO_ENV_VAR] = DEMO_ENV_ON;
    process.env[name] = value;
    expect(() => loadConfig()).toThrow(/fixes the database key/);
  });

  it('is loopback only: a wildcard HOST or a proxy origin is refused, as with any disabled login', () => {
    process.env[DEMO_ENV_VAR] = DEMO_ENV_ON;
    process.env['HOST'] = IPV4_WILDCARD_HOST;
    expect(() => loadConfig()).toThrow(/loopback/);
    delete process.env['HOST'];
    process.env['PUBLIC_URL'] = 'https://demo.example.com';
    expect(() => loadConfig()).toThrow(/loopback/);
  });

  it('demoConfig is the demo database on the demo port, and ignores the real install’s environment', () => {
    process.env['DB_PATH'] = '/real/fintrack.db';
    process.env['PORT'] = '3001';
    process.env['FINTRACK_DB_KEY'] = 'b'.repeat(64);
    process.env['FINTRACK_AUTH'] = AuthMode.enum.required;
    expect(demoConfig(DEMO_DB_PATH)).toMatchObject({
      DB_PATH: DEMO_DB_PATH,
      PORT: DEMO_PORT,
      HOST: LOOPBACK_HOST,
      MCP_TRANSPORT: 'http',
      FINTRACK_DB_KEY: DEMO_DB_KEY,
      FINTRACK_AUTH: AuthMode.enum.disabled,
    });
  });

  it('the demo database lives beside the real one, never as the same file', () => {
    delete process.env['DB_PATH'];
    expect(DEMO_DB_PATH).not.toBe(loadConfig().DB_PATH);
    expect(DEMO_DB_PATH.startsWith(homedir())).toBe(true);
  });
});

describe('DB_PATH under the demo', () => {
  it('defaults to the demo database, never the real one, when it is omitted', () => {
    delete process.env['DB_PATH'];
    process.env[DEMO_ENV_VAR] = DEMO_ENV_ON;
    expect(loadConfig().DB_PATH).toBe(DEMO_DB_PATH);
    delete process.env[DEMO_ENV_VAR];
    expect(loadConfig().DB_PATH).not.toBe(DEMO_DB_PATH);
  });

  it('is respected when set', () => {
    process.env['DB_PATH'] = '/custom/demo.db';
    process.env[DEMO_ENV_VAR] = DEMO_ENV_ON;
    expect(loadConfig().DB_PATH).toBe('/custom/demo.db');
  });
});

describe('osLocale', () => {
  it('takes the first locale variable that is set, in LC_ALL, LC_MESSAGES, LANG order', () => {
    expect(osLocale({ LC_ALL: 'es_CO.UTF-8', LANG: 'en_US.UTF-8' })).toBe('es_CO.UTF-8');
    expect(osLocale({ LC_ALL: '', LC_MESSAGES: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('pt_BR.UTF-8');
    expect(osLocale({ LANG: 'en_US.UTF-8' })).toBe('en_US.UTF-8');
  });

  it('falls back to the runtime’s locale when none is set', () => {
    expect(osLocale({})).toBe(Intl.DateTimeFormat().resolvedOptions().locale);
  });
});
