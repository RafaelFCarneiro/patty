import { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import * as modelAccount from '../../models/account.js'

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default currency follows the default language (en → USD); default type is the most common account.
export const CreateAccountSchema = modelAccount.CreateAccountSchema.extend({
  type: modelAccount.AccountType.default(modelAccount.AccountType.enum.checking)
    .describe('checking | savings | wallet | investment (credit is card-managed)'),
  currency: CurrencyCode.default(CurrencyCode.enum.USD).describe('Account currency (ISO code); defaults to USD'),
})
export type CreateAccount = z.infer<typeof CreateAccountSchema>

export const UpdateAccountSchema = modelAccount.UpdateAccountSchema
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>
