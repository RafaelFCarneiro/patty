import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';

export const SetBaseCurrencySchema = z.object({
  baseCurrency: CurrencyCode.describe('New base currency — the default target for future valuation'),
});
export type SetBaseCurrency = z.infer<typeof SetBaseCurrencySchema>;
