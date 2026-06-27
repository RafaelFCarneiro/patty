import { z } from 'zod'
import { PeriodSchema } from '../../models/date.js'
import { coerceToNumber } from './coerce.js'

export const CoercedPeriodSchema = PeriodSchema.extend({
  month: z.preprocess(coerceToNumber, PeriodSchema.shape.month),
  year: z.preprocess(coerceToNumber, PeriodSchema.shape.year),
})
export type CoercedPeriod = z.infer<typeof CoercedPeriodSchema>
