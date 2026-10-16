import { z } from 'zod';
import { listCurrencies } from '../../../controllers/currencies.js';
import { CurrencySchema } from '../../../models/money.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { READ_SCOPE } from '../../../models/auth/scope.js';

const CURRENCIES_TAG = 'Currencies';

const listCurrenciesRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/currencies',
  tags: [CURRENCIES_TAG],
  summary: 'List currencies',
  responses: { 200: okResponse('Currencies', z.array(CurrencySchema)) },
  handler: async (_req, _reply, scope) => listCurrencies(scope().deps),
};

export const currencyRoutes: RouteDefinition[] = [listCurrenciesRoute];
