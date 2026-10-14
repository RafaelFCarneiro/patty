import { getPreferences, setBaseCurrency } from '../../../controllers/settings.js';
import { PreferencesSchema } from '../../../models/locale.js';
import * as settingsAdapters from '../../../adapters/settings.js';
import { SetBaseCurrencySchema } from '../../../wire/in/settings.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { parse, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const SETTINGS_TAG = 'Settings';

export const settingsRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'get',
      scope: READ_SCOPE,
      path: '/api/preferences',
      tags: [SETTINGS_TAG],
      summary: 'Get user preferences',
      responses: { 200: okResponse('Preferences', PreferencesSchema) },
      handler: async () => getPreferences(deps),
    },
    {
      method: 'post',
      scope: WRITE_SCOPE,
      path: '/api/settings/base-currency',
      tags: [SETTINGS_TAG],
      summary: 'Set base currency',
      request: { body: jsonBody(SetBaseCurrencySchema) },
      responses: {
        200: okResponse('Base currency updated', PreferencesSchema.pick({ baseCurrency: true })),
        422: validation422,
      },
      handler: async (req, reply) => {
        const input = parse(SetBaseCurrencySchema, req.body, reply);
        if (!input) return reply;
        const flow = () => setBaseCurrency(deps, input).map(settingsAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
  ];
};
