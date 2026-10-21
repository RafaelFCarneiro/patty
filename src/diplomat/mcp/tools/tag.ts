import { ToolName } from '../tool-name.js';
import { z } from 'zod';
import { createTag, deleteTag, listTags } from '../../../controllers/tags.js';
import { CreateTagSchema } from '../../../wire/in/tags.js';
import * as tagAdapters from '../../../adapters/tags.js';
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const listTagsTool = defineTool({
  name: ToolName.enum.list_tags,
  config: {
    annotations: READ_ONLY,
    title: 'List tags',
    description: 'List all tags.',
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await listTags(deps));
  },
});

const createTagDescription =
  'Create a tag. Tags can be attached to transactions to label them ' + '(e.g. "work", "travel", "reembolsável").';

const createTagTool = defineTool({
  name: ToolName.enum.create_tag,
  config: {
    annotations: MUTATING,
    title: 'Create tag',
    description: createTagDescription,
    inputSchema: CreateTagSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => createTag(deps, args.name).map(tagAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const deleteTagTool = defineTool({
  name: ToolName.enum.delete_tag,
  config: {
    annotations: MUTATING,
    title: 'Delete tag',
    description: 'Delete a tag by id. Removes the tag and all its associations with transactions.',
    inputSchema: { id: z.string().min(1) },
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => deleteTag(deps, args.id).map(tagAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

export const tagTools = [listTagsTool, createTagTool, deleteTagTool];
