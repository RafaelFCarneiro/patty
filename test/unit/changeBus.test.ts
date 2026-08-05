import { describe, expect, it, vi } from 'vitest';
import { createChangeBus } from '../../src/changeBus.js';

describe('createChangeBus (ADR-027 Phase 3)', () => {
  it('delivers a publish to every subscriber', () => {
    const bus = createChangeBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe(first);
    bus.subscribe(second);

    bus.publish(['account']);

    expect(first).toHaveBeenCalledWith(['account']);
    expect(second).toHaveBeenCalledWith(['account']);
  });

  it('stops delivering once unsubscribed, without affecting other subscribers', () => {
    const bus = createChangeBus();
    const unsubscribed = vi.fn();
    const stillSubscribed = vi.fn();
    const unsubscribe = bus.subscribe(unsubscribed);
    bus.subscribe(stillSubscribed);

    unsubscribe();
    bus.publish(['transaction']);

    expect(unsubscribed).not.toHaveBeenCalled();
    expect(stillSubscribed).toHaveBeenCalledWith(['transaction']);
  });

  it('a publish with no subscribers is a no-op, not a throw', () => {
    const bus = createChangeBus();
    expect(() => bus.publish(['tag'])).not.toThrow();
  });

  it('supports many subscribers at once without hitting a max-listeners warning', () => {
    const bus = createChangeBus();
    const warn = vi.spyOn(process, 'emitWarning');

    for (let i = 0; i < 20; i += 1) bus.subscribe(vi.fn());
    bus.publish(['account']);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
