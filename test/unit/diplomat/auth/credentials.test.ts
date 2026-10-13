import { describe, expect, it } from 'vitest';
import {
  createSecrets,
  hashPassword,
  hashSecret,
  randomAccessToken,
  randomDeviceCode,
  randomSetupCode,
  randomToken,
  randomUserCode,
  verifyPassword,
} from '../../../../src/diplomat/auth/credentials.js';
import { normalizeSetupCode } from '../../../../src/logic/auth.js';
import { TOKEN_PREFIX } from '../../../../src/models/auth.js';

describe('passwords', () => {
  it('hashes with argon2id at the OWASP first-choice parameters', async () => {
    const hash = await hashPassword('a perfectly fine passphrase');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=47104,t=1,p=1\$/);
  });

  it('salts: the same password never hashes the same twice', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('a perfectly fine passphrase');
    expect(await verifyPassword(hash, 'a perfectly fine passphrase')).toBe(true);
    expect(await verifyPassword(hash, 'a perfectly fine passphrasE')).toBe(false);
  });

  it('treats an unreadable stored hash as a mismatch rather than throwing', async () => {
    expect(await verifyPassword('not a phc string', 'whatever')).toBe(false);
    expect(await verifyPassword('', 'whatever')).toBe(false);
  });

  it('builds a dummy hash that no typed password matches', async () => {
    const secrets = await createSecrets();
    expect(secrets.dummyPasswordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(secrets.dummyPasswordHash, 'anything at all')).toBe(false);
  });
});

describe('tokens and codes', () => {
  it('mints 256-bit base64url session tokens that never repeat', () => {
    const tokens = new Set(Array.from({ length: 50 }, randomToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('mints 20-symbol setup codes from the unambiguous Crockford alphabet', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = randomSetupCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
      expect(normalizeSetupCode(code)).toBe(code);
    }
  });

  it('mints 8-symbol sign-in user codes from the same alphabet, and they normalize to themselves', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = randomUserCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(normalizeSetupCode(code)).toBe(code);
    }
  });

  it('mints 256-bit base64url device codes that never repeat', () => {
    const codes = new Set(Array.from({ length: 50 }, randomDeviceCode));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes secrets with sha256 hex, deterministically', () => {
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
  });
});

describe('randomAccessToken', () => {
  it('is ftk_ + 32 random bytes, base64url — greppable and unguessable', () => {
    const token = randomAccessToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 base64url chars
  });

  it('never repeats', () => {
    expect(new Set(Array.from({ length: 50 }, randomAccessToken)).size).toBe(50);
  });

  it('is the one createSecrets hands the controllers', async () => {
    expect((await createSecrets()).randomAccessToken().startsWith(TOKEN_PREFIX)).toBe(true);
  });
});
