import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST, LOOPBACK_HOST } from '../../src/common/net.js';
import { loadConfig } from '../../src/config.js';
import { AuthMode } from '../../src/models/auth/mode.js';
import { DEFAULT_PROFILE } from '../../src/models/auth/sign-in.js';

const ORIGINAL_ENV = { ...process.env };
const AUTH_VARS = [
  'PATTY_AUTH',
  'PATTY_PROFILE',
  'PATTY_TOKEN',
  'PUBLIC_URL',
  'TRUST_PROXY',
  'HOST',
  'PATTY_DB_KEY',
  'PATTY_DB_KEY_FILE',
];

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

describe('PATTY_AUTH × HOST (ADR-034 §1)', () => {
  it.each([
    LOOPBACK_HOST,
    '127.0.0.2',
    'localhost',
    '::1',
    IPV4_WILDCARD_HOST,
    IPV6_WILDCARD_HOST,
    '192.168.1.10',
    'patty.lan',
  ])('defaults HOST=%s to required — loopback included', (host) => {
    expect(withEnv({ HOST: host }).PATTY_AUTH).toBe(AuthMode.enum.required);
  });

  it('defaults to required when HOST is omitted (the npm/stdio install)', () => {
    expect(loadConfig().PATTY_AUTH).toBe(AuthMode.enum.required);
  });

  it('lets a loopback instance say required explicitly', () => {
    expect(withEnv({ PATTY_AUTH: 'required' }).PATTY_AUTH).toBe(AuthMode.enum.required);
  });

  it('lets a non-loopback host say required explicitly', () => {
    expect(withEnv({ HOST: IPV4_WILDCARD_HOST, PATTY_AUTH: 'required' }).PATTY_AUTH).toBe('required');
  });

  it.each([LOOPBACK_HOST, '127.0.0.2', 'localhost', '::1'])(
    'still allows an explicit disabled on loopback HOST=%s',
    (host) => {
      expect(withEnv({ HOST: host, PATTY_AUTH: 'disabled' }).PATTY_AUTH).toBe('disabled');
    },
  );

  it.each([IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST, '192.168.1.10', 'patty.lan'])(
    'rejects PATTY_AUTH=disabled on non-loopback HOST=%s with an actionable message',
    (host) => {
      process.env['HOST'] = host;
      process.env['PATTY_AUTH'] = 'disabled';
      expect(() => loadConfig()).toThrow(/PATTY_AUTH=disabled is only allowed on a loopback HOST/);
      expect(() => loadConfig()).toThrow(/defaults to required/);
    },
  );

  it('rejects an unknown PATTY_AUTH value', () => {
    process.env['PATTY_AUTH'] = 'maybe';
    expect(() => loadConfig()).toThrow();
  });

  it.each([undefined, IPV4_WILDCARD_HOST])('treats an empty PATTY_AUTH as unset (HOST=%s)', (host) => {
    expect(withEnv({ ...(host ? { HOST: host } : {}), PATTY_AUTH: '' }).PATTY_AUTH).toBe('required');
  });
});

describe('a reverse proxy in front makes the instance exposed even on a loopback bind', () => {
  it('defaults to required when PUBLIC_URL names the external origin', () => {
    expect(withEnv({ PUBLIC_URL: 'https://patty.example.com' }).PATTY_AUTH).toBe('required');
  });

  it.each(['true', '1', '2', 'loopback', '10.0.0.0/8'])('defaults to required when TRUST_PROXY=%s', (trust) => {
    expect(withEnv({ TRUST_PROXY: trust }).PATTY_AUTH).toBe('required');
  });

  it.each(['false', '0'])('is required too when TRUST_PROXY=%s says there is no proxy to trust', (trust) => {
    expect(withEnv({ TRUST_PROXY: trust }).PATTY_AUTH).toBe('required');
  });

  it('still allows disabled with TRUST_PROXY=false: no proxy means not exposed', () => {
    expect(withEnv({ TRUST_PROXY: 'false', PATTY_AUTH: 'disabled' }).PATTY_AUTH).toBe('disabled');
  });

  it('rejects PATTY_AUTH=disabled with a PUBLIC_URL, naming the proxy case', () => {
    process.env['PATTY_AUTH'] = 'disabled';
    process.env['PUBLIC_URL'] = 'https://patty.example.com';
    expect(() => loadConfig()).toThrow(/PUBLIC_URL or TRUST_PROXY/);
  });

  it('rejects PATTY_AUTH=disabled with TRUST_PROXY set', () => {
    process.env['PATTY_AUTH'] = 'disabled';
    process.env['TRUST_PROXY'] = '1';
    expect(() => loadConfig()).toThrow(/reverse proxy/);
  });

  it('still allows an explicit required', () => {
    expect(withEnv({ PUBLIC_URL: 'https://patty.example.com', PATTY_AUTH: 'required' }).PATTY_AUTH).toBe(
      'required',
    );
  });
});

describe('PUBLIC_URL', () => {
  it('is optional', () => {
    expect(loadConfig().PUBLIC_URL).toBeUndefined();
    expect(withEnv({ PUBLIC_URL: '' }).PUBLIC_URL).toBeUndefined();
  });

  it.each(['https://patty.example.com', 'http://192.168.1.10:51737', 'https://patty.example.com:8443'])(
    'accepts the origin %s',
    (url) => {
      expect(withEnv({ PUBLIC_URL: url }).PUBLIC_URL).toBe(url);
    },
  );

  it.each([
    'https://patty.example.com/',
    'https://patty.example.com/app',
    'https://patty.example.com?x=1',
    'patty.example.com',
    'ftp://patty.example.com',
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

describe('PATTY_PROFILE and PATTY_TOKEN (ADR-034 §2)', () => {
  it('defaults the profile to "default" and leaves the token unset', () => {
    const config = loadConfig();
    expect(config.PATTY_PROFILE).toBe(DEFAULT_PROFILE);
    expect(config.PATTY_TOKEN).toBeUndefined();
  });

  it('treats an empty value like an unset one', () => {
    const config = withEnv({ PATTY_PROFILE: '', PATTY_TOKEN: '' });
    expect(config.PATTY_PROFILE).toBe(DEFAULT_PROFILE);
    expect(config.PATTY_TOKEN).toBeUndefined();
  });

  it('accepts a named profile', () => {
    expect(withEnv({ PATTY_PROFILE: 'work.laptop-2' }).PATTY_PROFILE).toBe('work.laptop-2');
  });

  it.each(['has space', 'colon:inside', 'a/b', 'x'.repeat(65)])(
    'rejects the profile %j, which could not name a keychain account',
    (profile) => {
      expect(() => withEnv({ PATTY_PROFILE: profile })).toThrow();
    },
  );

  it('carries PATTY_TOKEN through untouched — judging it is the stdio session’s job, per call', () => {
    expect(withEnv({ PATTY_TOKEN: 'ptk_whatever' }).PATTY_TOKEN).toBe('ptk_whatever');
    expect(withEnv({ PATTY_TOKEN: 'not-a-token' }).PATTY_TOKEN).toBe('not-a-token');
  });
});
