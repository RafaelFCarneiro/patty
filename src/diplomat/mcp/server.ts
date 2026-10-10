import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps, RunEffects, RunEffectsSequence } from '../../controllers/deps.js';
import { buildOpenApiDocument } from '../http/openapi.js';
import { buildRouteDefinitions } from '../http/routes.js';
import type { McpContext } from './context.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { guardToolScopes, type ScopeGuardOptions } from './scopes.js';
import { registerAccountTools } from './tools/account.js';
import { registerAggregateTools } from './tools/aggregate.js';
import { registerBudgetTools } from './tools/budget.js';
import { registerCategoryTools } from './tools/category.js';
import { registerCorrelationsTools } from './tools/correlations.js';
import { registerCreditCardTools } from './tools/creditCard.js';
import { registerCurrencyRateTools } from './tools/currencyRates.js';
import { registerDashboardTools } from './tools/dashboard.js';
import { registerRecurringTools } from './tools/recurring.js';
import { registerSummaryTools } from './tools/summary.js';
import { registerSystemTools } from './tools/system.js';
import { registerTagTools } from './tools/tag.js';
import { registerTransactionTools } from './tools/transaction.js';
import { registerTransferTools } from './tools/transfer.js';

/** Thin diplomat: MCP tools delegate to the same controllers as HTTP. Aggregation only (ADR-025) —
 *  each domain's tools/resources/prompts are registered by their own module. */

export const buildMcpServer = (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  scopeGuard: ScopeGuardOptions = { requireAuthInfo: false },
): McpServer => {
  const server = new McpServer({ name: 'fintrack', version });
  guardToolScopes(server, scopeGuard);
  const ctx: McpContext = { deps, version, runEffects, runEffectsSequence, resetLocale };

  registerPrompts(server, ctx);

  const openApiDocument = buildOpenApiDocument(
    buildRouteDefinitions(deps, version, runEffects, runEffectsSequence),
    version,
  );
  registerResources(server, ctx, openApiDocument);

  registerAccountTools(server, ctx);
  registerCreditCardTools(server, ctx);
  registerCurrencyRateTools(server, ctx);
  registerTransactionTools(server, ctx);
  registerTransferTools(server, ctx);
  registerBudgetTools(server, ctx);
  registerRecurringTools(server, ctx);
  registerCategoryTools(server, ctx);
  registerTagTools(server, ctx);
  registerDashboardTools(server, ctx);
  registerCorrelationsTools(server, ctx);
  registerAggregateTools(server, ctx);
  registerSummaryTools(server, ctx);
  registerSystemTools(server, ctx);

  return server;
};
