import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import * as modelAccount from '../../models/account.js';
import { IsoDateQuerySchema } from './coerce.js';

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default currency follows the default language (en → USD); default type is the most common account.
export const CreateAccountSchema = modelAccount.CreateAccountSchema.extend({
  type: modelAccount.CreateAccountSchema.shape.type.default(modelAccount.AccountType.enum.checking),
  currency: modelAccount.CreateAccountSchema.shape.currency.default(CurrencyCode.enum.USD),
});
export type CreateAccount = z.infer<typeof CreateAccountSchema>;

export const UpdateAccountSchema = modelAccount.UpdateAccountSchema;
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>;

// Pass-through — no boundary-only defaults needed; every field required by the domain schema is
// already required here.
export const AddAccountMovementSchema = modelAccount.AddAccountMovementSchema;
export type AddAccountMovement = z.infer<typeof AddAccountMovementSchema>;

// Pass-through — no boundary-only defaults needed.
export const UpdateAccountTransactionSchema = modelAccount.UpdateAccountTransactionSchema;
export type UpdateAccountTransaction = z.infer<typeof UpdateAccountTransactionSchema>;

// Pass-through — no boundary-only defaults needed.
export const CreateTransferSchema = modelAccount.CreateTransferSchema;
export type CreateTransfer = z.infer<typeof CreateTransferSchema>;

// Pass-through — no boundary-only defaults needed.
export const ImportAccountStatementSchema = modelAccount.ImportAccountStatementSchema;
export type ImportAccountStatement = z.infer<typeof ImportAccountStatementSchema>;

export const AccountsQuerySchema = z.object({ type: modelAccount.AccountType.optional() });
export type AccountsQuery = z.infer<typeof AccountsQuerySchema>;

export const AccountBalancesQuerySchema = z.object({
  account: z.string().optional(),
  type: modelAccount.AccountType.optional(),
  projectedAsOf: IsoDateQuerySchema.optional(),
});
export type AccountBalancesQuery = z.infer<typeof AccountBalancesQuerySchema>;
