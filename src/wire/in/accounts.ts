import { z } from 'zod'
import * as modelAccount from '../../models/account.js'

export const CreateAccount = modelAccount.CreateAccountSchema
export type CreateAccount = z.infer<typeof CreateAccount>

export const UpdateAccountSchema = modelAccount.UpdateAccountSchema
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>
