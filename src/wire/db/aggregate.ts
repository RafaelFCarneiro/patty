import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import { parseCategoryNames } from './categories.js';

export const AggregateDbRowSchema = z
  .object({
    key: z.string().nullable(),
    label: z.string().nullable(),
    label_names: z.string().nullable().default(null),
    currency: CurrencyCode,
    value: z.number(),
    count: z.number().int(),
  })
  .transform(({ label_names, ...rest }) => ({
    ...rest,
    labelNames: parseCategoryNames(label_names),
  }));

export type AggregateDbRow = z.output<typeof AggregateDbRowSchema>;
