import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenancy } from '../../controllers/deps.js';
import { DEFAULT_INSTANCE_KIND, type InstanceKind } from '../../models/instance.js';
import { documentationContext } from '../http/context.js';
import { buildOpenApiDocument } from '../http/openapi.js';
import { buildRouteDefinitions } from '../http/routes.js';
import { createMcpContext } from './context.js';
import { MCP_SERVER_NAME, serverInstructions } from './instructions.js';
import { promptDefinitions } from './prompts.js';
import { registerDefinitions } from './register.js';
import { resourceDefinitions } from './resources.js';
import { guardScopes, type ScopeGuardOptions } from './scopes.js';
import { toolDefinitions } from './tools/index.js';

/** Thin diplomat: MCP tools delegate to the same controllers as HTTP. Aggregation only (ADR-025) — each domain
 *  module exports its definitions, and the one generic registrar (`register.ts`) registers them. */

export const buildMcpServer = (
  tenancy: Tenancy,
  version: string,
  scopeGuard: ScopeGuardOptions,
  kind: InstanceKind = DEFAULT_INSTANCE_KIND,
): McpServer => {
  const server = new McpServer({ name: MCP_SERVER_NAME, version }, { instructions: serverInstructions(kind) });
  guardScopes(server, scopeGuard);
  const ctx = createMcpContext(tenancy, version);

  const openApiDocument = buildOpenApiDocument(buildRouteDefinitions(documentationContext(version)), version);
  registerDefinitions(server, ctx, {
    prompts: promptDefinitions,
    resources: resourceDefinitions(openApiDocument),
    tools: toolDefinitions,
  });

  return server;
};
