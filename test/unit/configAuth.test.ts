import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST, LOOPBACK_HOST } from '../../src/common/net.js';
import { defaultAuthMode, loadConfig } from '../../src/config.js';
import { AuthMode } from '../../src/models/auth.js';

const ORIGINAL_ENV = { ...process.env };
const AUTH_VARS = ['FINTRACK_AUTH', 'PUBLIC_URL', 'TRUST_PROXY', 'HOST', 'FINTRACK_DB_KEY', 'FINTRACK_DB_KEY_FILE'];

beforeEach(() => {
  AUTH_VARS.forEach((name) => delete process.env[name]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const withEnv = (env: Record<string, string>) => {
  Object.assign(process.env, env);
  return loadConfig();
};

describe('FINTRACK_AUTH × HOST (ADR-033 §1)', () => {
  it.each([
    [LOOPBACK_HOST, AuthMode.enum.disabled],
    ['127.0.0.2', AuthMode.enum.disabled],
    ['localhost', AuthMode.enum.disabled],
    ['::1', AuthMode.enum.disabled],
    [IPV4_WILDCARD_HOST, AuthMode.enum.required],
    [IPV6_WILDCARD_HOST, AuthMode.enum.required],
    ['192.168.1.10', AuthMode.enum.required],
    ['fintrack.lan', AuthMode.enum.required],
  ])('defaults HOST=%s to %s', (host, expected) => {
    expect(withEnv({ HOST: host }).FINTRACK_AUTH).toBe(expected);
    expect(defaultAuthMode(host)).toBe(expected);
  });

  it('defaults to disabled when HOST is omitted (the npm/stdio zero-config case)', () => {
    expect(loadConfig().FINTRACK_AUTH).toBe(AuthMode.enum.disabled);
  });

  it('lets a loopback instance opt in to required', () => {
    expect(withEnv({ FINTRACK_AUTH: 'required' }).FINTRACK_AUTH).toBe(AuthMode.enum.required);
  });

  it('lets a non-loopback host say required explicitly', () => {
    expect(withEnv({ HOST: IPV4_WILDCARD_HOST, FINTRACK_AUTH: 'required' }).FINTRACK_AUTH).toBe('required');
  });

  it('allows disabled on a loopback host', () => {
    expect(withEnv({ HOST: '127.0.0.1', FINTRACK_AUTH: 'disabled' }).FINTRACK_AUTH).toBe('disabled');
  });

  it.each([IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST, '192.168.1.10', 'fintrack.lan'])(
    'rejects FINTRACK_AUTH=disabled on non-loopback HOST=%s with an actionable message',
    (host) => {
      process.env['HOST'] = host;
      process.env['FINTRACK_AUTH'] = 'disabled';
      expect(() => loadConfig()).toThrow(/FINTRACK_AUTH=disabled is only allowed on a loopback HOST/);
      expect(() => loadConfig()).toThrow(/defaults to required/);
    },
  );

  it('rejects an unknown FINTRACK_AUTH value', () => {
    process.env['FINTRACK_AUTH'] = 'maybe';
    expect(() => loadConfig()).toThrow();
  });

  it('treats an empty FINTRACK_AUTH as unset', () => {
    expect(withEnv({ HOST: IPV4_WILDCARD_HOST, FINTRACK_AUTH: '' }).FINTRACK_AUTH).toBe('required');
  });
});

describe('PUBLIC_URL', () => {
  it('is optional', () => {
    expect(loadConfig().PUBLIC_URL).toBeUndefined();
    expect(withEnv({ PUBLIC_URL: '' }).PUBLIC_URL).toBeUndefined();
  });

  it.each(['https://fintrack.example.com', 'http://192.168.1.10:51737', 'https://fintrack.example.com:8443'])(
    'accepts the origin %s',
    (url) => {
      expect(withEnv({ PUBLIC_URL: url }).PUBLIC_URL).toBe(url);
    },
  );

  it.each([
    'https://fintrack.example.com/',
    'https://fintrack.example.com/app',
    'https://fintrack.example.com?x=1',
    'fintrack.example.com',
    'ftp://fintrack.example.com',
    'javascript:alert(1)',
    '/relative',
  ])('rejects %s', (url) => {
    process.env['PUBLIC_URL'] = url;
    expect(() => loadConfig()).toThrow(/PUBLIC_URL|Invalid url/);
  });
});

describe('TRUST_PROXY', () => {
  it('is optional', () => {
    expect(loadConfig().TRUST_PROXY).toBeUndefined();
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', 1],
    ['2', 2],
    ['loopback', 'loopback'],
    ['10.0.0.0/8,172.16.0.0/12', '10.0.0.0/8,172.16.0.0/12'],
  ])('parses %s for Fastify', (raw, expected) => {
    expect(withEnv({ TRUST_PROXY: raw }).TRUST_PROXY).toBe(expected);
  });
});
