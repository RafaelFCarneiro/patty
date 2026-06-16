import { z } from 'zod'

// Credit-card row from a Drizzle select (camelCase keys). Loose; CreditCard.parse
// enforces domain constraints downstream.
export const CreditCardRowSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  closingDay:  z.number(),
  dueDay:      z.number(),
  limitAmount: z.number().nullable(),
  currency:    z.string(),
})
