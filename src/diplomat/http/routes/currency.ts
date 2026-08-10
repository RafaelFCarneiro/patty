import { z } from 'zod';
import { listCurrencies } from '../../../controllers/currencies.js';
import { CurrencySchema } from '../../../models/money.js';
import type { HttpContext } from '../context.js';
import { okResponse, type RouteDefinition } from '../openapi.js';

const CURRENCIES_TAG = 'Currencies';

export const currencyRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps } = ctx;
  return [
    {
      method: 'get',
      path: '/api/currencies',
      tags: [CURRENCIES_TAG],
      summary: 'List currencies',
      responses: { 200: okResponse('Currencies', z.array(CurrencySchema)) },
      handler: async () => listCurrencies(deps),
    },
  ];
};
