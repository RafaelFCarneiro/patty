import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTag, deleteTag, listTags } from '../../../controllers/tags.js';
import { CreateTagSchema } from '../../../wire/in/tags.js';
import * as tagAdapters from '../../../adapters/tags.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';

export const registerTagTools = (server: McpServer, ctx: McpContext): void => {
  const { deps, runEffects } = ctx;

  server.registerTool('list_tags', { title: 'List tags', description: 'List all tags.', inputSchema: {} }, async () =>
    json(await listTags(deps)),
  );

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description:
        'Create a tag. Tags can be attached to transactions to label them ' +
        '(e.g. "work", "travel", "reembolsável").',
      inputSchema: CreateTagSchema.shape,
    },
    async (args) => {
      const flow = () => createTag(deps, args.name).map(tagAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description: 'Delete a tag by id. Removes the tag and all its associations with transactions.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const flow = () => deleteTag(deps, args.id).map(tagAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
