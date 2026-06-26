import { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import * as modelAccount from '../../models/account.js'

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default currency follows the default language (en → USD); default type is the most common account.
export const CreateAccountSchema = modelAccount.CreateAccountSchema.extend({
  type: modelAccount.CreateAccountSchema.shape.type.default(modelAccount.AccountType.enum.checking),
  currency: modelAccount.CreateAccountSchema.shape.currency.default(CurrencyCode.enum.USD),
})
export type CreateAccount = z.infer<typeof CreateAccountSchema>

export const UpdateAccountSchema = modelAccount.UpdateAccountSchema
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>
