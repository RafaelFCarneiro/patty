import { z } from 'zod'

export const CurrencyCode = z.enum(['USD', 'BRL'])
export type CurrencyCode = z.infer<typeof CurrencyCode>

export const Money = z.number().positive()
