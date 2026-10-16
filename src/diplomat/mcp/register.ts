import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from './context.js';
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './definition.js';

export type EdgeDefinitions = {
  prompts: readonly PromptDefinition[];
  resources: readonly ResourceDefinition[];
  tools: readonly ToolDefinition[];
};

/**
 * The one registrar (ADR-025): registers any list of definitions on `server`. `server.registerTool/Resource/Prompt`
 * are the scope-guarded ones (`guardScopes`), so a definition cannot be registered around the guard; each callback asks
 * `ctx.as` for the caller's scoped dependencies, built from the principal the guard put on `extra`.
 */
export const registerDefinitions = (server: McpServer, ctx: McpContext, definitions: EdgeDefinitions): void => {
  definitions.prompts.forEach(({ name, config, handle }) =>
    server.registerPrompt(name, config, (args, extra) => handle(args, ctx.as(extra), ctx)),
  );
  definitions.resources.forEach(({ name, uri, config, read }) =>
    server.registerResource(name, uri, config, (resourceUri, extra) => read(resourceUri, ctx.as(extra), ctx)),
  );
  definitions.tools.forEach(({ name, config, handle }) =>
    server.registerTool(name, config, (args, extra) => handle(args, ctx.as(extra), ctx)),
  );
};
