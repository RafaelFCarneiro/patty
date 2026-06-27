import { z } from 'zod'
import { AggregateMetric, AggregateSort, AggregateSpendingSchema } from '../../models/aggregate.js'
import { coerceToNumber } from './coerce.js'

export const AggregateSpendingInput = AggregateSpendingSchema.extend({
  metric: AggregateSpendingSchema.shape.metric.default(AggregateMetric.enum.sum),
  sort: AggregateSpendingSchema.shape.sort.default(AggregateSort.enum.desc),
  limit: AggregateSpendingSchema.shape.limit.default(50),
  month: z.preprocess(coerceToNumber, AggregateSpendingSchema.shape.month),
  year: z.preprocess(coerceToNumber, AggregateSpendingSchema.shape.year),
})
export type AggregateSpendingInput = z.infer<typeof AggregateSpendingInput>
