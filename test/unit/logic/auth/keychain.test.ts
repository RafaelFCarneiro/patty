import { describe, expect, it } from 'vitest';
import { dbIdOf, keychainAccount } from '../../../../src/logic/auth/keychain.js';

describe('keychain account', () => {
  it('keeps the first twelve characters of the database path hash', () => {
    expect(dbIdOf('0123456789abcdef0123')).toBe('0123456789ab');
  });

  it('names the account signin:<profile>:<dbId>, so two databases or profiles never share one', () => {
    expect(keychainAccount('default', 'aaaaaaaaaaaa')).toBe('signin:default:aaaaaaaaaaaa');
    expect(keychainAccount('work', 'aaaaaaaaaaaa')).not.toBe(keychainAccount('work', 'bbbbbbbbbbbb'));
    expect(keychainAccount('work', 'aaaaaaaaaaaa')).not.toBe(keychainAccount('home', 'aaaaaaaaaaaa'));
  });
});
