import { ToolName } from '../toolName.js';
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
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const createCategoryTool = defineTool({
  name: ToolName.enum.create_category,
  config: {
    annotations: MUTATING,
    title: 'Create category',
    description: 'Create a category. Prefer existing categories (list_categories) before creating new ones.',
    inputSchema: CreateCategorySchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => createCategory(deps, args).map(categoryAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listCategoriesTool = defineTool({
  name: ToolName.enum.list_categories,
  config: {
    annotations: READ_ONLY,
    title: 'List categories',
    description: 'List all categories. Names are resolved to the active locale for default categories.',
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await listCategories(deps));
  },
});

const createSubCategoryDescription =
  'Create a sub-category under an existing category. Sub-categories inherit the kind (expense/income/both) ' +
  'of their parent. Use list_categories to find the parent id. Names must be unique within the same parent.';

const createSubCategoryTool = defineTool({
  name: ToolName.enum.create_sub_category,
  config: {
    annotations: MUTATING,
    title: 'Create sub-category',
    description: createSubCategoryDescription,
    inputSchema: CreateSubCategorySchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => createSubCategory(deps, args).map(categoryAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listSubCategoriesTool = defineTool({
  name: ToolName.enum.list_sub_categories,
  config: {
    annotations: READ_ONLY,
    title: 'List sub-categories',
    description: 'List all sub-categories, optionally filtered by parent category id.',
    inputSchema: {
      parentId: z.string().optional().describe('Filter to sub-categories of this parent category id'),
    },
  },
  handle: async (args, { deps }) => {
    return json(await listSubCategories(deps, args.parentId));
  },
});

const deleteCategoryDescription =
  'Delete a category by name. Blocked if any transactions, recurring rules, or sub-categories reference it — ' +
  'returns an in_use error with reference counts so you can guide the user to clear them first. ' +
  "On success, also removes the category's learned merchant classification rules (re-learnable).";

const deleteCategoryTool = defineTool({
  name: ToolName.enum.delete_category,
  config: {
    annotations: MUTATING,
    title: 'Delete category',
    description: deleteCategoryDescription,
    inputSchema: { name: z.string().min(1).describe('Category name') },
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => deleteCategory(deps, args.name).map(categoryAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const deleteSubCategoryDescription =
  'Delete a sub-category by name. Blocked if any transactions, recurring rules, ' +
  'or child sub-categories reference it — ' +
  'returns an in_use error with reference counts. ' +
  'On success, also removes learned merchant classification rules for this sub-category.';

const deleteSubCategoryTool = defineTool({
  name: ToolName.enum.delete_sub_category,
  config: {
    annotations: MUTATING,
    title: 'Delete sub-category',
    description: deleteSubCategoryDescription,
    inputSchema: { name: z.string().min(1).describe('Sub-category name') },
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => deleteSubCategory(deps, args.name).map(categoryAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

export const categoryTools = [
  createCategoryTool,
  listCategoriesTool,
  createSubCategoryTool,
  listSubCategoriesTool,
  deleteCategoryTool,
  deleteSubCategoryTool,
];
