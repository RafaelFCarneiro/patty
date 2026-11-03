import { describe, expect, it } from 'vitest';
import {
  failureOfSeedStatus,
  planDemoDatabase as planFor,
  refusalWithoutProbe,
} from '../../../../src/logic/demo/database.js';
import { DemoFailureCode, DemoSeedStatus, type DemoProbe } from '../../../../src/models/demo/core.js';
import { InstanceKind } from '../../../../src/models/instance.js';

const { real_database, not_demo } = DemoFailureCode.enum;
const PROBES: readonly DemoProbe[] = ['missing', 'unreadable', InstanceKind.enum.standard, InstanceKind.enum.demo];

type Facts = Parameters<typeof planFor>[0];
const plan = (facts: Pick<Facts, 'isRealDatabase' | 'reset' | 'probe'> & Partial<Facts>) =>
  planFor({ isAlias: false, holdsData: false, ...facts });

describe('planDemoDatabase', () => {
  it.each([false, true])('refuses a symlink at the demo path (reset=%s), whatever it points at', (reset) => {
    for (const probe of ['missing', InstanceKind.enum.demo, InstanceKind.enum.standard] as const) {
      expect(plan({ isRealDatabase: false, isAlias: true, reset, probe })._unsafeUnwrapErr()).toBe(not_demo);
    }
  });

  it.each([false, true])(
    'refuses a standard database that holds data before anything is migrated (reset=%s)',
    (reset) => {
      const facts = { isRealDatabase: false, reset, probe: InstanceKind.enum.standard, holdsData: true } as const;
      expect(plan(facts)._unsafeUnwrapErr()).toBe(not_demo);
    },
  );

  it.each(PROBES)('refuses the real database whatever it holds (%s), with or without a reset', (probe) => {
    for (const reset of [false, true]) {
      expect(plan({ isRealDatabase: true, reset, probe })._unsafeUnwrapErr()).toBe(real_database);
    }
  });

  it('refuses a file that does not open as a demo database, and never deletes it', () => {
    for (const reset of [false, true]) {
      expect(plan({ isRealDatabase: false, reset, probe: 'unreadable' })._unsafeUnwrapErr()).toBe(not_demo);
    }
  });

  it('refuses to reset a standard database', () => {
    const facts = { isRealDatabase: false, reset: true, probe: InstanceKind.enum.standard } as const;
    expect(plan(facts)._unsafeUnwrapErr()).toBe(not_demo);
  });

  it('leaves a standard database to the seeder when no reset was asked (empty: seeded; with data: refused)', () => {
    const facts = { isRealDatabase: false, reset: false, probe: InstanceKind.enum.standard } as const;
    expect(plan(facts)._unsafeUnwrap()).toMatchObject({ deleteFirst: false });
  });

  it.each([
    [false, 'missing', false],
    [true, 'missing', false],
    [false, InstanceKind.enum.demo, false],
    [true, InstanceKind.enum.demo, true],
  ] as const)(
    'reset=%s on %s → delete first: %s (only a demo database is ever deleted)',
    (reset, probe, deleteFirst) => {
      expect(plan({ isRealDatabase: false, reset, probe })._unsafeUnwrap()).toMatchObject({ deleteFirst });
    },
  );
});

describe('planDemoDatabase — who owns the file', () => {
  it.each([
    ['a missing file', false, 'missing', true],
    ['a missing file, with a reset', true, 'missing', true],
    ['a demo being reset (recreated by this run)', true, InstanceKind.enum.demo, true],
    ['a demo left in place', false, InstanceKind.enum.demo, false],
    ['an empty standard database that was already there', false, InstanceKind.enum.standard, false],
  ] as const)('createdHere for %s', (_label, reset, probe, createdHere) => {
    expect(plan({ isRealDatabase: false, reset, probe })._unsafeUnwrap().createdHere).toBe(createdHere);
  });
});

describe('failureOfSeedStatus', () => {
  it.each([
    [DemoSeedStatus.enum.seeded, null],
    [DemoSeedStatus.enum.present, null],
    [DemoSeedStatus.enum.interrupted, DemoFailureCode.enum.interrupted],
    [DemoSeedStatus.enum.not_demo, DemoFailureCode.enum.not_demo],
  ])('%s → %s', (status, failure) => {
    expect(failureOfSeedStatus(status)).toBe(failure);
  });
});

describe('refusalWithoutProbe', () => {
  it.each([
    [{ isRealDatabase: true, isAlias: false }, DemoFailureCode.enum.real_database],
    [{ isRealDatabase: true, isAlias: true }, DemoFailureCode.enum.real_database],
    [{ isRealDatabase: false, isAlias: true }, DemoFailureCode.enum.not_demo],
    [{ isRealDatabase: false, isAlias: false }, null],
  ])('%j → %s', (location, refusal) => {
    expect(refusalWithoutProbe(location)).toBe(refusal);
  });
});
