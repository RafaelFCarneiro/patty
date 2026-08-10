import type { Currency } from '../models/money.js';
import type { Deps } from './deps.js';

export const listCurrencies = (deps: Deps): Promise<Currency[]> => deps.currencies.list();
