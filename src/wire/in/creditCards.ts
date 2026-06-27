import type { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import * as modelCreditCard from '../../models/creditCard.js'

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default currency follows the default language (en → USD).
export const CreateCreditCardSchema = modelCreditCard.CreateCreditCardSchema.extend({
  currency: modelCreditCard.CreateCreditCardSchema.shape.currency.default(CurrencyCode.enum.USD),
})
export type CreateCreditCard = z.infer<typeof CreateCreditCardSchema>
