import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withKeyLock } from '../../src/diplomat/db/key-lock.js';

it('diagnostic: two simultaneous writers never overlap', async () => {
  const report: string[] = [];
  for (let i = 0; i < 100; i++) {
    const path = join(mkdtempSync(join(tmpdir(), 'kl-')), 'x.lock');
    const log: string[] = [];
    const w = (name: string) =>
      withKeyLock(
        async () => {
          log.push(`${name} in`);
          await Promise.resolve();
          log.push(`${name} out`);
        },
        path,
        2000,
      );
    await Promise.all([w('a'), w('b')]);
    const overlapped = log.join(',') !== 'a in,a out,b in,b out' && log.join(',') !== 'b in,b out,a in,a out';
    if (overlapped) report.push(`#${i}: ${log.join(',')}`);
  }
  expect(report).toEqual([]);
}, 120000);
