import { z } from 'zod';
import { parseCategoryNames } from './categories.js';

/** One row of the `merchants/top` repo query — `category_name`/`category_names` are both null
 *  when the merchant's transactions carry no category at all (`logic`/controller resolves the
 *  display fallback, same pattern as `MerchantSpendDbRowSchema`). */
export const MerchantTopDbRowSchema = z
  .object({
    merchant: z.string().min(1),
    transaction_count: z.number(),
    category_name: z.string().nullable(),
    category_names: z.string().nullable().default(null),
  })
  .transform(({ transaction_count, category_name, category_names, ...rest }) => ({
    ...rest,
    transactionCount: transaction_count,
    categoryName: category_name,
    categoryNames: parseCategoryNames(category_names),
  }));

export type MerchantTopDbRow = z.output<typeof MerchantTopDbRowSchema>;
