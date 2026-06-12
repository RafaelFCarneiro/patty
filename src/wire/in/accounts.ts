import { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import { Account } from '../../models/account.js'

export const CreateAccount = Account.omit({ id: true }).extend({
  currency: CurrencyCode.default('BRL'),
})
export type CreateAccount = z.infer<typeof CreateAccount>
