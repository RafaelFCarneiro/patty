import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYCHAIN_SERVICE, KeychainFailureCode } from '../../../../src/models/auth/signIn.js';

const keyring = vi.hoisted(() => {
  const state = { password: null as string | null, constructed: [] as Array<[string, string]>, failing: false };
  class Entry {
    constructor(service: string, account: string) {
      state.constructed.push([service, account]);
    }
    getPassword(): string | null {
      if (state.failing) throw new Error('keychain locked');
      return state.password;
    }
    setPassword(value: string): void {
      if (state.failing) throw new Error('keychain locked');
      state.password = value;
    }
    deletePassword(): boolean {
      if (state.failing) throw new Error('keychain locked');
      state.password = null;
      return true;
    }
  }
  return { state, Entry };
});

vi.mock('@napi-rs/keyring', () => ({ Entry: keyring.Entry }));

import { keychainSignInStore } from '../../../../src/diplomat/auth/signInStore.js';

const ACCOUNT = 'signin:default:0123456789ab';

beforeEach(() => {
  keyring.state.password = null;
  keyring.state.constructed = [];
  keyring.state.failing = false;
});

describe('keychainSignInStore', () => {
  it('keeps a sign-in under service "fintrack" and the given account, and reads it back', async () => {
    const store = keychainSignInStore(ACCOUNT, () => undefined);
    expect((await store.load())._unsafeUnwrap()).toBeNull();
    expect(await store.save('ftk_secret')).toBe(true);
    expect((await store.load())._unsafeUnwrap()).toBe('ftk_secret');
    expect(new Set(keyring.state.constructed.map(([service, account]) => `${service}|${account}`))).toEqual(
      new Set([`${KEYCHAIN_SERVICE}|${ACCOUNT}`]),
    );
    expect(KEYCHAIN_SERVICE).toBe('fintrack');
  });

  it('forgets it on clear, and clearing nothing is harmless', async () => {
    const store = keychainSignInStore(ACCOUNT, () => undefined);
    await store.save('ftk_secret');
    await store.clear();
    expect((await store.load())._unsafeUnwrap()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('tells an unreadable keychain apart from an empty one: missing is null, unreachable is an error', async () => {
    const store = keychainSignInStore(ACCOUNT, () => undefined);
    expect((await store.load())._unsafeUnwrap()).toBeNull();
    keyring.state.failing = true;
    expect((await store.load())._unsafeUnwrapErr().code).toBe(KeychainFailureCode.enum.keychain_unavailable);
  });

  it('reports a keychain that refuses a write — without the secret — and says it did not save', async () => {
    keyring.state.failing = true;
    const reported: string[] = [];
    const saved = await keychainSignInStore(ACCOUNT, (message) => reported.push(message)).save('ftk_secret');
    expect(saved).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).not.toContain('ftk_secret');
  });

  it('survives a failing clear', async () => {
    keyring.state.failing = true;
    await expect(keychainSignInStore(ACCOUNT, () => undefined).clear()).resolves.toBeUndefined();
  });
});
