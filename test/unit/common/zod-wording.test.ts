import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../../src/common/zod-wording.js';

const messageOf = (schema: z.ZodType, input: unknown): string | undefined => {
  const result = schema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
};

// The built-in messages keep the zod 3 wording people already read (ADR-037 §3).
describe('zod wording', () => {
  it.each([
    [z.string().min(1), '', 'String must contain at least 1 character(s)'],
    [z.string().max(2), 'abc', 'String must contain at most 2 character(s)'],
    [z.array(z.string()).min(1), [], 'Array must contain at least 1 element(s)'],
    [z.number().min(1), 0, 'Number must be greater than or equal to 1'],
    [z.number().max(12), 13, 'Number must be less than or equal to 12'],
    [z.number().positive(), 0, 'Number must be greater than 0'],
    [z.number().int(), 1.5, 'Expected integer, received float'],
    [z.string(), 5, 'Expected string, received number'],
    [z.string(), undefined, 'Required'],
    [z.string(), null, 'Expected string, received null'],
    [z.enum(['a', 'b']), 'c', "Invalid enum value. Expected 'a' | 'b', received 'c'"],
    [z.enum(['a', 'b']), undefined, 'Required'],
    [z.enum(['a', 'b']), null, "Expected 'a' | 'b', received null"],
    [z.enum(['a', 'b']), 5, "Expected 'a' | 'b', received number"],
    [z.literal('a'), 'b', 'Invalid literal value, expected "a"'],
    [z.strictObject({ a: z.string() }), { a: 'x', b: 1, c: 2 }, "Unrecognized key(s) in object: 'b', 'c'"],
    [z.url(), 'nope', 'Invalid url'],
    [z.string().regex(/^a$/), 'b', 'Invalid'],
    [z.number().multipleOf(5), 3, 'Number must be a multiple of 5'],
    [z.string().refine(() => false), 'x', 'Invalid input'],
  ])('%#', (schema, input, expected) => {
    expect(messageOf(schema, input)).toBe(expected);
  });

  it('keeps a message the schema names itself', () => {
    expect(messageOf(z.string({ error: 'mine' }), 5)).toBe('mine');
    expect(messageOf(z.string().min(1, 'mine too'), '')).toBe('mine too');
  });
});
