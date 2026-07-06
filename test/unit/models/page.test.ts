import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CURSOR_VERSION,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  pageSchema,
  SortDirection,
} from '../../../src/models/page.js';

const SortField = z.enum(['date', 'amount']);
const TestCursorSchema = cursorSchema(SortField);

describe('pageSchema', () => {
  const ItemSchema = z.object({ id: z.string() });
  const Page = pageSchema(ItemSchema);

  it('accepts items with nextCursor and total present', () => {
    const parsed = Page.safeParse({ items: [{ id: 'a' }], nextCursor: 'abc', total: 3 });
    expect(parsed.success).toBe(true);
  });

  it('accepts items with nextCursor and total both absent (last page, no includeTotal)', () => {
    const parsed = Page.safeParse({ items: [] });
    expect(parsed.success).toBe(true);
  });
});

describe('cursor codec', () => {
  it('round-trips through encode/decode', () => {
    const payload = {
      v: CURSOR_VERSION,
      sort: 'date' as const,
      dir: SortDirection.enum.desc,
      key: { value: '2026-06-01', id: 'tx-1' },
    };
    const token = encodeCursor(payload);
    expect(typeof token).toBe('string');
    const decoded = decodeCursor(TestCursorSchema, token);
    expect(decoded).toEqual(payload);
  });

  it('round-trips a numeric key value (amount sort)', () => {
    const payload = {
      v: CURSOR_VERSION,
      sort: 'amount' as const,
      dir: SortDirection.enum.asc,
      key: { value: 42.5, id: 'tx-2' },
    };
    const decoded = decodeCursor(TestCursorSchema, encodeCursor(payload));
    expect(decoded).toEqual(payload);
  });

  it('rejects a cursor that is not valid base64url JSON', () => {
    expect(decodeCursor(TestCursorSchema, 'not-a-real-cursor!!!')).toBeNull();
  });

  it('rejects a cursor whose decoded payload fails the schema (wrong shape)', () => {
    const token = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, sort: 'date' }), 'utf8').toString('base64url');
    expect(decodeCursor(TestCursorSchema, token)).toBeNull();
  });

  it('rejects a cursor with an unknown version', () => {
    const token = Buffer.from(
      JSON.stringify({ v: 999, sort: 'date', dir: 'desc', key: { value: '2026-06-01', id: 'tx-1' } }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(TestCursorSchema, token)).toBeNull();
  });

  it('rejects a cursor produced for a different sort enum', () => {
    const token = Buffer.from(
      JSON.stringify({
        v: CURSOR_VERSION,
        sort: 'not-a-sort-field',
        dir: 'desc',
        key: { value: '2026-06-01', id: 'tx-1' },
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(TestCursorSchema, token)).toBeNull();
  });
});
