import { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import { CreditCard } from '../../models/creditCard.js'

export const CreateCreditCard = CreditCard.omit({ id: true }).extend({
  currency: CurrencyCode.default('BRL'),
})
export type CreateCreditCard = z.infer<typeof CreateCreditCard>
