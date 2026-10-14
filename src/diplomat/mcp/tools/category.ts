import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createCategory,
  createSubCategory,
  deleteCategory,
  deleteSubCategory,
  listCategories,
  listSubCategories,
} from '../../../controllers/categories.js';
import { CreateCategorySchema, CreateSubCategorySchema } from '../../../wire/in/categories.js';
import * as categoryAdapters from '../../../adapters/categories.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

export const registerCategoryTools = (server: McpServer, ctx: McpContext): void => {
  server.registerTool(
    'create_category',
    {
      annotations: MUTATING,
      title: 'Create category',
      description: 'Create a category. Prefer existing categories (list_categories) before creating new ones.',
      inputSchema: CreateCategorySchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => createCategory(deps, args).map(categoryAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'list_categories',
    {
      annotations: READ_ONLY,
      title: 'List categories',
      description: 'List all categories. Names are resolved to the active locale for default categories.',
      inputSchema: {},
    },
    async (_args, extra) => {
      const { deps } = ctx.as(extra);
      return json(await listCategories(deps));
    },
  );

  server.registerTool(
    'create_sub_category',
    {
      annotations: MUTATING,
      title: 'Create sub-category',
      description:
        'Create a sub-category under an existing category. Sub-categories inherit the kind (expense/income/both) ' +
        'of their parent. Use list_categories to find the parent id. Names must be unique within the same parent.',
      inputSchema: CreateSubCategorySchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => createSubCategory(deps, args).map(categoryAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'list_sub_categories',
    {
      annotations: READ_ONLY,
      title: 'List sub-categories',
      description: 'List all sub-categories, optionally filtered by parent category id.',
      inputSchema: {
        parentId: z.string().optional().describe('Filter to sub-categories of this parent category id'),
      },
    },
    async (args, extra) => {
      const { deps } = ctx.as(extra);
      return json(await listSubCategories(deps, args.parentId));
    },
  );

  server.registerTool(
    'delete_category',
    {
      annotations: MUTATING,
      title: 'Delete category',
      description:
        'Delete a category by name. Blocked if any transactions, recurring rules, or sub-categories reference it — ' +
        'returns an in_use error with reference counts so you can guide the user to clear them first. ' +
        "On success, also removes the category's learned merchant classification rules (re-learnable).",
      inputSchema: { name: z.string().min(1).describe('Category name') },
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => deleteCategory(deps, args.name).map(categoryAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'delete_sub_category',
    {
      annotations: MUTATING,
      title: 'Delete sub-category',
      description:
        'Delete a sub-category by name. Blocked if any transactions, recurring rules, ' +
        'or child sub-categories reference it — ' +
        'returns an in_use error with reference counts. ' +
        'On success, also removes learned merchant classification rules for this sub-category.',
      inputSchema: { name: z.string().min(1).describe('Sub-category name') },
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => deleteSubCategory(deps, args.name).map(categoryAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
