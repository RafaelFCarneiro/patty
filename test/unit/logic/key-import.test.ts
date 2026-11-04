import { describe, expect, it } from 'vitest';
import { decodeKeyFile, keyImportRefusal } from '../../../src/logic/key-import.js';
import { KeyImportRefusal, type KeySources } from '../../../src/models/key-import.js';

const KEY = 'ab'.repeat(32);

describe('decodeKeyFile', () => {
  it('reads the key with or without one trailing newline, as `key export` writes it', () => {
    expect(decodeKeyFile(`${KEY}\n`)).toBe(KEY);
    expect(decodeKeyFile(KEY)).toBe(KEY);
  });

  it.each([
    ['empty', ''],
    ['short', KEY.slice(1)],
    ['long', `${KEY}0`],
    ['not hexadecimal', `${'g'.repeat(64)}`],
    ['two newlines', `${KEY}\n\n`],
    ['a carriage return', `${KEY}\r\n`],
    ['leading whitespace', ` ${KEY}`],
  ])('answers null for %s', (_name, contents) => {
    expect(decodeKeyFile(contents)).toBeNull();
  });
});

describe('keyImportRefusal', () => {
  const none: KeySources = { keyFileConfigured: false, keyEnvConfigured: false, keychainHoldsKey: false };

  it('allows an import when nothing else supplies a key', () => {
    expect(keyImportRefusal(none)).toBeNull();
  });

  it.each([
    [{ keyFileConfigured: true }, KeyImportRefusal.enum.key_file_configured],
    [{ keyEnvConfigured: true }, KeyImportRefusal.enum.key_env_configured],
    [{ keychainHoldsKey: true }, KeyImportRefusal.enum.keychain_holds_key],
  ])('refuses %j', (override, refusal) => {
    expect(keyImportRefusal({ ...none, ...override })).toBe(refusal);
  });

  it('names the configured source first when several apply', () => {
    expect(keyImportRefusal({ keyFileConfigured: true, keyEnvConfigured: true, keychainHoldsKey: true })).toBe(
      KeyImportRefusal.enum.key_file_configured,
    );
  });
});
