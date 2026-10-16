import { z } from 'zod';
import { listExchangeRates, setExchangeRate } from '../../../controllers/currencyRates.js';
import { buildBulkResult } from '../../../logic/currencyRate.js';
import { CurrencyRateViewSchema, SetExchangeRateSchema } from '../../../models/currencyRate.js';
import * as currencyRateAdapters from '../../../adapters/currencyRates.js';
import { SetExchangeRatesSchema } from '../../../wire/in/currencyRates.js';
import { BulkSetExchangeRatesOut } from '../../../wire/out/currencyRates.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { parse, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const EXCHANGE_RATES_TAG = 'Exchange rates';

const listExchangeRatesRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/exchange-rates',
  tags: [EXCHANGE_RATES_TAG],
  summary: 'List exchange rates',
  responses: { 200: okResponse('Exchange rates', z.array(CurrencyRateViewSchema)) },
  handler: async (_req, _reply, scope) => listExchangeRates(scope().deps),
};

const setExchangeRateRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/exchange-rates',
  tags: [EXCHANGE_RATES_TAG],
  summary: 'Set exchange rate (upsert)',
  request: { body: jsonBody(SetExchangeRateSchema) },
  responses: { 200: okResponse('Rate upserted', CurrencyRateViewSchema), 422: validation422 },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const input = parse(SetExchangeRateSchema, req.body, reply);
    if (!input) return reply;
    const flow = () => setExchangeRate(deps, input).map(currencyRateAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

const setExchangeRatesRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/exchange-rates/bulk',
  tags: [EXCHANGE_RATES_TAG],
  summary: 'Set exchange rates (bulk upsert, partial success)',
  request: { body: jsonBody(SetExchangeRatesSchema) },
  responses: { 200: okResponse('Bulk upsert result', BulkSetExchangeRatesOut), 422: validation422 },
  // Orchestration (plan → run each item → bulk result) that belongs in a controller; kept as one named step here.
  handler: async (req, reply, scope) => {
    const { deps, runEffectsSequence } = scope();
    const input = parse(SetExchangeRatesSchema, req.body, reply);
    if (!input) return reply;
    const outcomes = await runEffectsSequence(
      input.rates,
      (item) => () => setExchangeRate(deps, item).map(currencyRateAdapters.outcomeToDb),
    );
    return reply.send(currencyRateAdapters.bulkResultToWireOut(buildBulkResult(input.rates, outcomes)));
  },
};

export const currencyRateRoutes: RouteDefinition[] = [
  listExchangeRatesRoute,
  setExchangeRateRoute,
  setExchangeRatesRoute,
];
