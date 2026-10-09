import { describe, expect, it } from 'vitest';
import { getHealth, getStatus } from '../../../src/controllers/status.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { Locale } from '../../../src/models/locale.js';

const depsWith = (reachable: boolean): Deps =>
  ({
    health: { reachable: async () => reachable },
    locale: async () => Locale.enum.en,
  }) as unknown as Deps;

describe('getHealth — the one public probe', () => {
  it('reports db ok when the database answers', async () => {
    expect(await getHealth(depsWith(true))).toEqual({ status: 'ok', db: 'ok' });
  });

  it('stays alive but reports db error when the database is unreachable', async () => {
    expect(await getHealth(depsWith(false))).toEqual({ status: 'ok', db: 'error' });
  });

  it('exposes nothing but liveness and the database state', async () => {
    expect(Object.keys(await getHealth(depsWith(true))).sort()).toEqual(['db', 'status']);
  });
});

describe('getStatus', () => {
  it("shares the health probe's database check", async () => {
    expect((await getStatus(depsWith(false), '1.2.3')).db).toBe('error');
    expect((await getStatus(depsWith(true), '1.2.3')).db).toBe('ok');
  });
});
