import { describe, expect, it } from 'vitest';
import { DEFAULT_LANDING_PATH, normalizeUsername } from '../../../../src/models/auth.js';
import { LoginFormSchema, NextQuerySchema, safeNextPath, SetupFormSchema } from '../../../../src/wire/in/auth.js';

describe('normalizeUsername', () => {
  it('trims and lower-cases so the UNIQUE index is case-insensitive', () => {
    expect(normalizeUsername('  RaFaEl ')).toBe('rafael');
  });

  it('folds compatibility forms (NFKC), so a lookalike full-width name collides with the plain one', () => {
    expect(normalizeUsername('ＲＡＦＡＥＬ')).toBe('rafael');
  });
});

describe('safeNextPath — open-redirect guard', () => {
  it.each(['/ui', '/ui/overview', '/ui/budget?month=3&year=2026', '/ui/a%20b'])(
    'keeps the same-origin path %s',
    (next) => {
      expect(safeNextPath(next)).toBe(next);
    },
  );

  it.each([
    undefined,
    '',
    'https://evil.example',
    'http://evil.example/ui',
    '//evil.example',
    '//evil.example/ui',
    '/\\evil.example',
    '\\\\evil.example',
    '/ui\\..\\evil',
    'javascript:alert(1)',
    'ui/overview',
    '/api/accounts',
    '/uix',
    '/ui/../api/accounts',
    '/ui/%2e%2e/%2e%2e/api',
    '/ui\r\nLocation: https://evil.example',
    '/ui\u0000',
    `/ui/${'a'.repeat(3000)}`,
  ])('falls back to the default for %j', (next) => {
    expect(safeNextPath(next)).toBe(DEFAULT_LANDING_PATH);
  });
});

describe('LoginFormSchema', () => {
  it('normalizes the username and validates next in one parse', () => {
    expect(LoginFormSchema.parse({ username: '  RaFaEl ', password: 'x', next: '/ui/budget' })).toEqual({
      username: 'rafael',
      password: 'x',
      next: '/ui/budget',
    });
  });

  it('turns an off-site next into the default rather than failing the form', () => {
    expect(LoginFormSchema.parse({ username: 'a', password: 'x', next: '//evil.example' }).next).toBe(
      DEFAULT_LANDING_PATH,
    );
    expect(LoginFormSchema.parse({ username: 'a', password: 'x' }).next).toBe(DEFAULT_LANDING_PATH);
  });

  it('accepts a password of any content (an unknown name must fail like a wrong password) but bounds its size', () => {
    expect(LoginFormSchema.safeParse({ username: 'a', password: 'short' }).success).toBe(true);
    expect(LoginFormSchema.safeParse({ username: 'a', password: 'x'.repeat(2000) }).success).toBe(false);
    expect(LoginFormSchema.safeParse({ username: '', password: 'x' }).success).toBe(false);
  });
});

describe('SetupFormSchema', () => {
  const valid = { code: 'ABCD-EFGH', username: '  Rafael ', password: 'correct horse battery' };

  it('normalizes the username', () => {
    expect(SetupFormSchema.parse(valid).username).toBe('rafael');
  });

  it('enforces the password policy: at least 12 characters, no composition rules', () => {
    expect(SetupFormSchema.safeParse({ ...valid, password: 'a'.repeat(11) }).success).toBe(false);
    expect(SetupFormSchema.safeParse({ ...valid, password: 'a'.repeat(12) }).success).toBe(true);
    expect(SetupFormSchema.safeParse({ ...valid, password: 'a'.repeat(1025) }).success).toBe(false);
  });

  it.each(['ab', 'has space', 'semi;colon', '<script>', 'x'.repeat(65)])('rejects the username %j', (username) => {
    expect(SetupFormSchema.safeParse({ ...valid, username }).success).toBe(false);
  });

  it('requires a code', () => {
    expect(SetupFormSchema.safeParse({ ...valid, code: '' }).success).toBe(false);
  });
});

describe('NextQuerySchema', () => {
  it('validates the next query parameter and defaults a missing or non-object query', () => {
    expect(NextQuerySchema.parse({ next: '/ui/budget' }).next).toBe('/ui/budget');
    expect(NextQuerySchema.parse({}).next).toBe(DEFAULT_LANDING_PATH);
    expect(NextQuerySchema.parse({ next: 'https://evil.example' }).next).toBe(DEFAULT_LANDING_PATH);
  });
});
