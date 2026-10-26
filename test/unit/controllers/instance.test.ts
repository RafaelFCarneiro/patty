import { describe, expect, it, vi } from 'vitest';
import { instanceFactsOf, markDemoInstance } from '../../../src/controllers/instance.js';
import type { AuthDeps } from '../../../src/controllers/deps.js';
import { PersistOp } from '@rfc0/effect-runner';
import { INSTANCE_SETTINGS_ENTITY_TAG } from '../../../src/models/auth/entity.js';
import { SignInCap } from '../../../src/models/auth/users.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';

const tenancyOf = (kind: InstanceKind, locale: Locale = Locale.enum.pt) => ({
  instanceKind: async () => kind,
  instanceLocale: vi.fn(async () => locale),
});

describe('instanceFactsOf', () => {
  it('names a demo’s language', async () => {
    const tenancy = tenancyOf(InstanceKind.enum.demo, Locale.enum.es);
    expect(await instanceFactsOf(tenancy)).toEqual({ kind: InstanceKind.enum.demo, locale: Locale.enum.es });
  });

  it('does not read a language for a standard database', async () => {
    const tenancy = tenancyOf(InstanceKind.enum.standard);
    expect(await instanceFactsOf(tenancy)).toEqual({ kind: InstanceKind.enum.standard, locale: Locale.enum.en });
    expect(tenancy.instanceLocale).not.toHaveBeenCalled();
  });
});

const settingsWith = (instanceKind: InstanceKind): Pick<AuthDeps, 'instanceSettings'> => ({
  instanceSettings: {
    get: async () => ({ id: 'singleton', maxSignInDuration: SignInCap.enum['30d'], instanceKind, version: 3 }),
  },
});

describe('markDemoInstance', () => {
  it('updates the singleton row to demo, at the version it read', async () => {
    const outcome = (await markDemoInstance(settingsWith(InstanceKind.enum.standard)))._unsafeUnwrap();
    expect(outcome.response).toBe(InstanceKind.enum.demo);
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: INSTANCE_SETTINGS_ENTITY_TAG,
        model: expect.objectContaining({ instanceKind: InstanceKind.enum.demo, version: 3 }),
      },
    ]);
  });

  it('writes nothing when the database already says demo', async () => {
    const outcome = (await markDemoInstance(settingsWith(InstanceKind.enum.demo)))._unsafeUnwrap();
    expect(outcome).toEqual({ persist: [], response: InstanceKind.enum.demo });
  });
});
