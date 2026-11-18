import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { buildBulkItems, toBulkItem } from '../../../src/logic/bulk-item.js';
import { BulkItemStatus } from '../../../src/models/bulk.js';

type Item = { name: string };
const shape = {
  applied: (value: number) => ({ value }),
  refused: (input: Item, error: string) => ({ name: input.name, error }),
};

describe('toBulkItem', () => {
  it('tags an applied item with the ok status constant and what it reports', () => {
    expect(toBulkItem({ name: 'a' }, ok(1), shape)).toEqual({ status: BulkItemStatus.enum.ok, value: 1 });
  });

  it('tags a refused item with the error status constant, the request it answers and the error', () => {
    expect(toBulkItem({ name: 'b' }, err('boom'), shape)).toEqual({
      status: BulkItemStatus.enum.error,
      name: 'b',
      error: 'boom',
    });
  });
});

describe('buildBulkItems', () => {
  it('pairs each outcome with its own request item, in order', () => {
    const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const result = buildBulkItems(items, [ok(1), err('boom'), ok(3)], shape);
    expect(result.map((item) => item.status)).toEqual(['ok', 'error', 'ok']);
    expect(result[1]).toMatchObject({ name: 'b', error: 'boom' });
  });

  it('is empty for no items', () => {
    expect(buildBulkItems([], [], shape)).toEqual([]);
  });
});
