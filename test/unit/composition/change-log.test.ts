import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/diplomat/db/driver.js';

const mocks = vi.hoisted(() => ({ append: vi.fn(), openChangeLog: vi.fn(), closeDatabase: vi.fn() }));

vi.mock('../../../src/diplomat/db/change-events.js', () => ({
  append: mocks.append,
  openChangeLog: mocks.openChangeLog,
}));
vi.mock('../../../src/diplomat/db/driver.js', () => ({ closeDatabase: mocks.closeDatabase }));

const { createAppendingBus } = await import('../../../src/composition/change-log.js');

const LOG = { tag: 'log' } as unknown as Db;
const NOW = new Date('2026-11-14T12:00:00.000Z');

const busWith = (onError = vi.fn()) => ({
  onError,
  ...createAppendingBus({ db: {} as Db, origin: 'proc-a', clock: () => NOW, onError }),
});

afterEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

describe('createAppendingBus', () => {
  it('tells local subscribers before it appends', async () => {
    const order: string[] = [];
    mocks.openChangeLog.mockResolvedValue(LOG);
    mocks.append.mockImplementation(async () => void order.push('append'));
    const { bus, settled } = busWith();
    bus.subscribe(() => order.push('local'));

    bus.publish({ userId: 'u1', entities: ['account'] });
    expect(order).toEqual(['local']);
    await settled();

    expect(order).toEqual(['local', 'append']);
  });

  it('appends the event with this process’s origin and the wall-clock time', async () => {
    mocks.openChangeLog.mockResolvedValue(LOG);
    const { bus, settled } = busWith();

    bus.publish({ userId: 'u1', entities: ['account', 'bill'] });
    await settled();

    expect(mocks.append).toHaveBeenCalledWith(LOG, {
      event: { userId: 'u1', entities: ['account', 'bill'] },
      origin: 'proc-a',
      createdAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('keeps publish order across appends, even when an earlier one is slow', async () => {
    mocks.openChangeLog.mockResolvedValue(LOG);
    const written: string[][] = [];
    mocks.append.mockImplementationOnce(async (_log, { event }) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      written.push([...event.entities]);
    });
    mocks.append.mockImplementation(async (_log, { event }) => void written.push([...event.entities]));
    const { bus, settled } = busWith();

    bus.publish({ userId: 'u1', entities: ['first'] });
    bus.publish({ userId: 'u1', entities: ['second'] });
    await settled();

    expect(written).toEqual([['first'], ['second']]);
  });

  it('reports a failed append to onError and never throws from publish; later events still append', async () => {
    mocks.openChangeLog.mockResolvedValue(LOG);
    const failure = new Error('database is locked');
    mocks.append.mockRejectedValueOnce(failure);
    const { bus, settled, onError } = busWith();
    const listener = vi.fn();
    bus.subscribe(listener);

    expect(() => bus.publish({ userId: 'u1', entities: ['tag'] })).not.toThrow();
    bus.publish({ userId: 'u1', entities: ['budget'] });
    await settled();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(mocks.append).toHaveBeenCalledTimes(2);
  });

  it('retries opening the log connection after it failed to open', async () => {
    const failure = new Error('cannot open');
    mocks.openChangeLog.mockRejectedValueOnce(failure).mockResolvedValue(LOG);
    const { bus, settled, onError } = busWith();

    bus.publish({ userId: 'u1', entities: ['tag'] });
    bus.publish({ userId: 'u1', entities: ['budget'] });
    await settled();

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(mocks.openChangeLog).toHaveBeenCalledTimes(2);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it('opens the log connection once, however many events follow', async () => {
    mocks.openChangeLog.mockResolvedValue(LOG);
    const { bus, settled } = busWith();

    bus.publish({ userId: 'u1', entities: ['tag'] });
    bus.publish({ userId: 'u1', entities: ['budget'] });
    await settled();

    expect(mocks.openChangeLog).toHaveBeenCalledTimes(1);
  });

  it('announces nothing for an event that names no entity, but still tells local subscribers', async () => {
    const { bus, settled } = busWith();
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.publish({ userId: null, entities: [] });
    await settled();

    expect(listener).toHaveBeenCalledOnce();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('publishLocal reaches local subscribers and never appends (no echo between processes)', async () => {
    const { publishLocal, bus, settled } = busWith();
    const listener = vi.fn();
    bus.subscribe(listener);

    publishLocal({ userId: 'u1', entities: ['account'] });
    await settled();

    expect(listener).toHaveBeenCalledWith({ userId: 'u1', entities: ['account'] });
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('close waits for queued appends, then releases the log connection', async () => {
    mocks.openChangeLog.mockResolvedValue(LOG);
    const { bus, close } = busWith();

    bus.publish({ userId: 'u1', entities: ['tag'] });
    await close();

    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.closeDatabase).toHaveBeenCalledWith(LOG);
  });

  it('close with nothing ever appended has no connection to release', async () => {
    const { close } = busWith();

    await close();

    expect(mocks.closeDatabase).not.toHaveBeenCalled();
  });
});
