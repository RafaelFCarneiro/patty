import { describe, expect, it } from 'vitest';
import { isBesideData, isDatabaseFile } from '../../../src/logic/export-destination.js';

describe('isBesideData', () => {
  const DATA = '/home/me/.patty';

  it('is true for the database directory itself', () => {
    expect(isBesideData(DATA, DATA)).toBe(true);
  });

  it('is true for a directory under it', () => {
    expect(isBesideData(DATA, `${DATA}/backups/2026`)).toBe(true);
  });

  it('is false for a sibling whose name merely starts the same', () => {
    expect(isBesideData(DATA, `${DATA}-keys`)).toBe(false);
  });

  it('is true for a directory whose name merely starts with two dots', () => {
    expect(isBesideData(DATA, `${DATA}/..sneaky`)).toBe(true);
  });

  it('is false for a parent, and for an unrelated directory', () => {
    expect(isBesideData(DATA, '/home/me')).toBe(false);
    expect(isBesideData(DATA, '/home/me/compose')).toBe(false);
  });
});

describe('isDatabaseFile', () => {
  it('is true only for the same file', () => {
    expect(isDatabaseFile('/data/patty.db', '/data/patty.db')).toBe(true);
    expect(isDatabaseFile('/data/patty.db', '/data/patty.snapshot.db')).toBe(false);
  });
});
