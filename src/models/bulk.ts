import { z } from 'zod';

export const BulkItemStatus = z.enum(['ok', 'error']);
export type BulkItemStatus = z.infer<typeof BulkItemStatus>;

export type BulkItemShape<I, V, E, Applied extends object, Refused extends object> = {
  applied: (value: V) => Applied;
  refused: (input: I, error: E) => Refused;
};
