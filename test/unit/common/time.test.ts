import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../../../src/common/time.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('sleep', () => {
  it('resolves only once the time has passed', async () => {
    const done = vi.fn();
    void sleep(100).then(done);

    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
  });
});
