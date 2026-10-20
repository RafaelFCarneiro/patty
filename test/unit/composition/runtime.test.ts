import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../../../src/composition/runtime.js';
import type { Db } from '../../../src/diplomat/db/driver.js';

const CONFIG = { FINTRACK_LOCALE: undefined, FIAT_RATE_STALE_HOURS: 36, CRYPTO_RATE_STALE_HOURS: 2 };
const principal = { userId: 'user-1' } as never;

afterEach(() => vi.restoreAllMocks());

describe('createRuntime defaults', () => {
  it('reads the wall clock unless a clock is given', () => {
    const { depsFor } = createRuntime({} as Db, CONFIG);

    expect(depsFor(principal).clock()).toBeInstanceOf(Date);
  });

  it('uses the given clock for every user it builds deps for', () => {
    const fixed = new Date('2026-01-02T03:04:05Z');
    const { depsFor } = createRuntime({} as Db, CONFIG, { clock: () => fixed });

    expect(depsFor(principal).clock()).toBe(fixed);
  });

  it('reports a failing change listener on stderr and keeps publishing to the others', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { changeBus } = createRuntime({} as Db, CONFIG);
    const failure = new Error('listener broke');
    const survivor = vi.fn();
    changeBus.subscribe(() => {
      throw failure;
    });
    changeBus.subscribe(survivor);

    changeBus.publish({ userId: 'user-1', entities: ['account'] });

    expect(report).toHaveBeenCalledWith('[fintrack] change notification failed:', failure);
    expect(survivor).toHaveBeenCalledWith({ userId: 'user-1', entities: ['account'] });
  });

  it('hands a failing listener to the given onChangeError instead of stderr', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onChangeError = vi.fn();
    const { changeBus } = createRuntime({} as Db, CONFIG, { onChangeError });
    const failure = new Error('listener broke');
    changeBus.subscribe(() => {
      throw failure;
    });

    changeBus.publish({ userId: null, entities: [] });

    expect(onChangeError).toHaveBeenCalledWith(failure);
    expect(report).not.toHaveBeenCalled();
  });
});
