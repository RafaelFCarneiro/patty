import type { FastifyInstance } from 'fastify';
import type { ChangeBus } from '@rfc0/effect-runner';
import type { Deps, RunEffects, RunEffectsSequence } from '../../controllers/deps.js';
import { AuthMode } from '../../models/auth.js';
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
import { registerUiRoutes } from './routes/ui.js';

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
export const buildRouteDefinitions = (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
): RouteDefinition[] => {
  const ctx: HttpContext = { deps, version, runEffects, runEffectsSequence };
  return [
    ...systemRoutes(ctx),
    ...accountRoutes(ctx),
    ...categoryRoutes(ctx),
    ...creditCardRoutes(ctx),
    ...currencyRoutes(ctx),
    ...currencyRateRoutes(ctx),
    ...settingsRoutes(ctx),
    ...transferRoutes(ctx),
    ...recurringRoutes(ctx),
    ...transactionRoutes(ctx),
    ...tagRoutes(ctx),
    ...dashboardRoutes(ctx),
    ...aggregateRoutes(ctx),
    ...summaryRoutes(ctx),
    ...budgetRoutes(ctx),
  ];
};

export const registerRoutes = (
  app: FastifyInstance,
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  subscribeToChanges: ChangeBus['subscribe'],
  auth: HttpAuth = DISABLED_AUTH,
): void => {
  const definitions = buildRouteDefinitions(deps, version, runEffects, runEffectsSequence);
  mountRoutes(app, definitions);

  const authRequired = auth.mode === AuthMode.enum.required;
  registerUiRoutes(app, subscribeToChanges, { logoutControl: authRequired });
  if (authRequired) registerAuthRoutes(app, auth);

  // Built from the same list just mounted; excluded from its own document by design.
  const openApiDocument = buildOpenApiDocument(definitions, version);
  app.get('/api/openapi.json', async (_req, reply) =>
    reply.header('cache-control', CACHE_CONTROL_NO_CACHE).send(openApiDocument),
  );
};
