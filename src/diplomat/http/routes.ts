import type { FastifyInstance } from 'fastify';
import type { ChangeBus } from '@rfc0/effect-runner';
import type { ChangeEvent } from '../../models/tenancy.js';
import { AuthMode } from '../../models/auth/mode.js';
import { READ_SCOPE } from '../../models/auth/scope.js';
import { DISABLED_AUTH, type HttpAuth, type HttpContext } from './context.js';
import { buildOpenApiDocument, mountRoutes, type RouteDefinition } from './openapi.js';
import { CACHE_CONTROL_NO_CACHE } from './respond.js';
import { accountRoutes } from './routes/account.js';
import { aggregateRoutes } from './routes/aggregate.js';
import { budgetRoutes } from './routes/budget.js';
import { categoryRoutes } from './routes/category.js';
import { creditCardRoutes } from './routes/creditCard.js';
import { currencyRoutes } from './routes/currency.js';
import { currencyRateRoutes } from './routes/currencyRates.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { recurringRoutes } from './routes/recurring.js';
import { settingsRoutes } from './routes/settings.js';
import { summaryRoutes } from './routes/summary.js';
import { systemRoutes } from './routes/system.js';
import { tagRoutes } from './routes/tag.js';
import { transactionRoutes } from './routes/transaction.js';
import { transferRoutes } from './routes/transfer.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConnectRoutes } from './routes/connect.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerProtectedResourceMetadataRoutes } from './routes/wellKnown.js';
import { registerUiRoutes, type SessionRecheck } from './routes/ui.js';
import { resolvePrincipal } from './session.js';

/**
 * Thin diplomat: zod-parse (wire/in) → wireInToModel → controller → map Result to HTTP.
 * Aggregation only (ADR-025) — each domain's routes are declared by its own module in
 * `routes/<domain>.ts`, mirroring `controllers/`. A new route lives in the domain module
 * matching its controller; this file never inlines a new registration.
 *
 * `buildRouteDefinitions` concatenates every domain's routes into ONE array — method, path,
 * OpenAPI docs, and the real handler together for each entry, still the single source of truth.
 * `registerRoutes` mounts this list on Fastify and documents it at `/api/openapi.json`; the MCP
 * resource `fintrack://openapi` documents the same list without ever mounting it — so there is
 * nowhere for the two surfaces to drift apart (ADR-013 Phase A).
 */
export const buildRouteDefinitions = (ctx: HttpContext): RouteDefinition[] => [
  ...systemRoutes(ctx),
  ...accountRoutes(),
  ...categoryRoutes(),
  ...creditCardRoutes(),
  ...currencyRoutes(),
  ...currencyRateRoutes(),
  ...settingsRoutes(),
  ...transferRoutes(),
  ...recurringRoutes(),
  ...transactionRoutes(),
  ...tagRoutes(),
  ...dashboardRoutes(),
  ...aggregateRoutes(),
  ...summaryRoutes(),
  ...budgetRoutes(),
];

// A long-lived stream is authenticated once, when it opens — so it asks again on this schedule.
const sessionRecheck = (auth: Extract<HttpAuth, { mode: typeof AuthMode.enum.required }>): SessionRecheck => ({
  isActive: async (req) => {
    const resolution = await resolvePrincipal(auth, req);
    return 'principal' in resolution && resolution.principal !== null;
  },
  everyMs: auth.sessionRecheckMs,
});

export const registerRoutes = (
  app: FastifyInstance,
  ctx: HttpContext,
  subscribeToChanges: ChangeBus<ChangeEvent>['subscribe'],
  auth: HttpAuth = DISABLED_AUTH,
): void => {
  const definitions = buildRouteDefinitions(ctx);
  mountRoutes(app, definitions, ctx);

  const authRequired = auth.mode === AuthMode.enum.required;
  registerUiRoutes(app, subscribeToChanges, {
    authControls: authRequired,
    session: authRequired ? sessionRecheck(auth) : undefined,
  });
  if (authRequired) {
    registerAuthRoutes(app, auth);
    registerTokenRoutes(app, auth);
    registerConnectRoutes(app, auth);
    registerProtectedResourceMetadataRoutes(app, auth.publicUrl);
  }

  // Built from the same list just mounted; excluded from its own document by design.
  const openApiDocument = buildOpenApiDocument(definitions, ctx.version);
  app.get('/api/openapi.json', { config: { scope: READ_SCOPE } }, async (_req, reply) =>
    reply.header('cache-control', CACHE_CONTROL_NO_CACHE).send(openApiDocument),
  );
};
