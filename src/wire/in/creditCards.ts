import type { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import * as modelCreditCard from '../../models/creditCard.js';

// The boundary owns quality-of-life defaults; the domain keeps these fields required (not-null).
// Default currency follows the default language (en → USD).
export const CreateCreditCardSchema = modelCreditCard.CreateCreditCardSchema.extend({
  currency: modelCreditCard.CreateCreditCardSchema.shape.currency.default(CurrencyCode.enum.USD),
});
export type CreateCreditCard = z.infer<typeof CreateCreditCardSchema>;

// Pass-through — no boundary-only defaults needed beyond what create_transaction already has.
export const AddCardPurchaseSchema = modelCreditCard.AddCardPurchaseSchema;
export type AddCardPurchase = z.infer<typeof AddCardPurchaseSchema>;
