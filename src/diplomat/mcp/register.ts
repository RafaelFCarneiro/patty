import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isEmpty } from 'remeda';
import { z } from 'zod';
import type { McpContext } from './context.js';
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './definition.js';
import '../../common/zod-wording.js';

/**
 * A tool's arguments are advertised as a closed object (`additionalProperties: false`) while an unknown argument is
 * still dropped, not rejected — what the surface said before zod 4, which only writes that keyword for a strict
 * object. `.meta` adds it to the generated JSON Schema without making the decoding strict. A tool with no
 * arguments never carried the keyword, and still does not.
 */
const toolInputSchema = (shape: ToolDefinition['config']['inputSchema']) =>
  isEmpty(Object.keys(shape)) ? z.object(shape) : z.object(shape).meta({ additionalProperties: false });

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
    config.argsSchema
      ? server.registerPrompt(name, { ...config, argsSchema: config.argsSchema }, (args, extra) =>
          handle(args, ctx.as(extra), ctx),
        )
      : server.registerPrompt(name, config, (extra) => handle({}, ctx.as(extra), ctx)),
  );
  definitions.resources.forEach(({ name, uri, config, read }) =>
    server.registerResource(name, uri, config, (resourceUri, extra) => read(resourceUri, ctx.as(extra), ctx)),
  );
  definitions.tools.forEach(({ name, config, handle }) =>
    server.registerTool(name, { ...config, inputSchema: toolInputSchema(config.inputSchema) }, (args, extra) =>
      handle(args, ctx.as(extra), ctx),
    ),
  );
};
