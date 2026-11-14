import { describe, expect, it } from 'vitest';
import { dbToModel } from '../../../src/adapters/change-events.js';

const row = { id: 3, userId: 'u1', entities: '["account","bill"]', origin: 'p', createdAt: '2026-11-14T12:00:00.000Z' };

describe('change-events dbToModel', () => {
  it('decodes a stored row into its event', () => {
    expect(dbToModel(row)).toEqual({ id: 3, origin: 'p', event: { userId: 'u1', entities: ['account', 'bill'] } });
  });

  it('keeps a null user', () => {
    expect(dbToModel({ ...row, userId: null })).toMatchObject({ event: { userId: null } });
  });

  it('skips a row whose entities are not JSON, keeping its id and the reason', () => {
    expect(dbToModel({ ...row, entities: 'nope' })).toEqual({ id: 3, skipped: 'entities is not valid JSON' });
  });

  it('skips a row whose entities are not an array of strings', () => {
    expect(dbToModel({ ...row, entities: '[1]' })).toMatchObject({ id: 3, skipped: expect.any(String) });
  });

  it('skips a row with no usable id as id 0', () => {
    expect(dbToModel({})).toMatchObject({ id: 0, skipped: expect.any(String) });
  });
});
