import { describe, expect, it } from 'vitest';
import { planDemoDatabase } from '../../../src/logic/demo-database.js';
import { DemoFailureCode, type DemoProbe } from '../../../src/models/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';

const { real_database, not_demo } = DemoFailureCode.enum;
const PROBES: readonly DemoProbe[] = ['missing', 'unreadable', InstanceKind.enum.standard, InstanceKind.enum.demo];

describe('planDemoDatabase', () => {
  it.each(PROBES)('refuses the real database whatever it holds (%s), with or without a reset', (probe) => {
    for (const reset of [false, true]) {
      expect(planDemoDatabase({ isRealDatabase: true, reset, probe })._unsafeUnwrapErr()).toBe(real_database);
    }
  });

  it('refuses a file that does not open as a demo database, and never deletes it', () => {
    for (const reset of [false, true]) {
      expect(planDemoDatabase({ isRealDatabase: false, reset, probe: 'unreadable' })._unsafeUnwrapErr()).toBe(not_demo);
    }
  });

  it('refuses to reset a standard database', () => {
    const facts = { isRealDatabase: false, reset: true, probe: InstanceKind.enum.standard } as const;
    expect(planDemoDatabase(facts)._unsafeUnwrapErr()).toBe(not_demo);
  });

  it('leaves a standard database to the seeder when no reset was asked (empty: seeded; with data: refused)', () => {
    const facts = { isRealDatabase: false, reset: false, probe: InstanceKind.enum.standard } as const;
    expect(planDemoDatabase(facts)._unsafeUnwrap()).toEqual({ deleteFirst: false });
  });

  it.each([
    [false, 'missing', false],
    [true, 'missing', false],
    [false, InstanceKind.enum.demo, false],
    [true, InstanceKind.enum.demo, true],
  ] as const)(
    'reset=%s on %s → delete first: %s (only a demo database is ever deleted)',
    (reset, probe, deleteFirst) => {
      expect(planDemoDatabase({ isRealDatabase: false, reset, probe })._unsafeUnwrap()).toEqual({ deleteFirst });
    },
  );
});
