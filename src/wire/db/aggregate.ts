import { z } from 'zod'
import { LocalizedNamesSchema } from '../../models/category.js'
import { CurrencyCode } from '../../models/money.js'

const parseCategoryNames = (raw: string | null): Record<string, string> | null =>
  raw ? LocalizedNamesSchema.parse(JSON.parse(raw)) : null

export const AggregateDbRowSchema = z.object({
  key: z.string(),
  label: z.string().nullable(),
  label_names: z.string().nullable().default(null),
  currency: CurrencyCode,
  value: z.number(),
  count: z.number().int(),
}).transform(({ label_names, ...rest }) => ({
  ...rest,
  labelNames: parseCategoryNames(label_names),
}))

export type AggregateDbRow = z.output<typeof AggregateDbRowSchema>
