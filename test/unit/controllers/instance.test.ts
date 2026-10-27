import { describe, expect, it, vi } from 'vitest';
import {
  completeDemoSeed,
  demoSeedStatus,
  instanceFactsOf,
  markDemoInstance,
} from '../../../src/controllers/instance.js';
import type { AuthDeps } from '../../../src/controllers/deps.js';
import { PersistOp } from '@rfc0/effect-runner';
import { INSTANCE_SETTINGS_ENTITY_TAG } from '../../../src/models/auth/entity.js';
import { SignInCap } from '../../../src/models/auth/users.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { DemoCountry, DemoSeedStatus } from '../../../src/models/demo.js';
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

const settingsWith = (
  instanceKind: InstanceKind,
  demoSeededAt: string | null = null,
  demoCountry: DemoCountry | null = null,
): Pick<AuthDeps, 'instanceSettings'> => ({
  instanceSettings: {
    get: async () => ({
      id: 'singleton',
      maxSignInDuration: SignInCap.enum['30d'],
      instanceKind,
      demoSeededAt,
      demoCountry,
      version: 3,
    }),
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

describe('completeDemoSeed', () => {
  const SEEDED_AT = '2026-10-26T12:00:00.000Z';

  it('records when the seed finished, at the version it read, keeping the kind', async () => {
    const settings = settingsWith(InstanceKind.enum.demo);
    const outcome = (await completeDemoSeed(settings, SEEDED_AT, DemoCountry.enum.mx))._unsafeUnwrap();
    expect(outcome.response).toBe(SEEDED_AT);
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: INSTANCE_SETTINGS_ENTITY_TAG,
        model: expect.objectContaining({
          instanceKind: InstanceKind.enum.demo,
          demoSeededAt: SEEDED_AT,
          demoCountry: DemoCountry.enum.mx,
          version: 3,
        }),
      },
    ]);
  });

  it('writes nothing, and keeps the first time, when the marker is already there', async () => {
    const earlier = '2026-10-01T08:00:00.000Z';
    const settings = settingsWith(InstanceKind.enum.demo, earlier);
    const outcome = (await completeDemoSeed(settings, SEEDED_AT, DemoCountry.enum.mx))._unsafeUnwrap();
    expect(outcome).toEqual({ persist: [], response: earlier });
  });
});

describe('demoSeedStatus', () => {
  const depsOf = (hasUserData: boolean, kind: InstanceKind, seededAt: string | null) => ({
    instance: { hasUserData: async () => hasUserData, kind: async () => kind },
    ...settingsWith(kind, seededAt),
  });

  it.each([
    ['an empty database', depsOf(false, InstanceKind.enum.standard, null), 'fresh'],
    ['a seeded demo', depsOf(true, InstanceKind.enum.demo, '2026-10-26T12:00:00.000Z'), DemoSeedStatus.enum.present],
    ['an interrupted demo', depsOf(true, InstanceKind.enum.demo, null), DemoSeedStatus.enum.interrupted],
    ['a standard database with data', depsOf(true, InstanceKind.enum.standard, null), DemoSeedStatus.enum.not_demo],
  ])('reads the three facts for %s and answers the pure rule’s verdict', async (_label, deps, expected) => {
    expect(await demoSeedStatus(deps as unknown as Parameters<typeof demoSeedStatus>[0])).toBe(expected);
  });
});
