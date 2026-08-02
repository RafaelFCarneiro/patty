import { z } from 'zod';
import * as categoryAdapters from '../../../adapters/categories.js';
import {
  createCategory,
  createSubCategory,
  deleteCategory,
  deleteSubCategory,
  listCategories,
  listSubCategories,
} from '../../../controllers/categories.js';
import { CategorySchema, SubCategorySchema } from '../../../models/category.js';
import * as wireInCategories from '../../../wire/in/categories.js';
import { DeletedOut } from '../../../wire/out/common.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, invalidQueryResponse, nameParam, notFound404, parse, send, validation422 } from '../respond.js';

const CATEGORIES_TAG = 'Categories';

export const categoryRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'get',
      path: '/api/categories',
      tags: [CATEGORIES_TAG],
      summary: 'List categories',
      responses: { 200: okResponse('Categories', z.array(CategorySchema)) },
      handler: async () => listCategories(deps),
    },
    {
      method: 'post',
      path: '/api/categories',
      tags: [CATEGORIES_TAG],
      summary: 'Create category',
      request: { body: jsonBody(wireInCategories.CreateCategorySchema) },
      responses: { 201: okResponse('Category created', CategorySchema), 409: conflict409, 422: validation422 },
      handler: async (req, reply) => {
        const wireIn = parse(wireInCategories.CreateCategorySchema, req.body, reply);
        if (!wireIn) return reply;
        const flow = () =>
          createCategory(deps, categoryAdapters.wireInToModel(wireIn)).map(categoryAdapters.outcomeToDb);
        return send(reply, await runEffects(flow), 201);
      },
    },
    {
      method: 'get',
      path: '/api/sub-categories',
      tags: [CATEGORIES_TAG],
      summary: 'List sub-categories',
      request: { query: wireInCategories.SubCategoriesQuerySchema },
      responses: { 200: okResponse('Sub-categories', z.array(SubCategorySchema)), 422: validation422 },
      handler: async (req, reply) => {
        const q = wireInCategories.SubCategoriesQuerySchema.safeParse(req.query);
        if (!q.success) return invalidQueryResponse(reply);
        return reply.send(await listSubCategories(deps, q.data.parentId));
      },
    },
    {
      method: 'post',
      path: '/api/sub-categories',
      tags: [CATEGORIES_TAG],
      summary: 'Create sub-category',
      request: { body: jsonBody(wireInCategories.CreateSubCategorySchema) },
      responses: {
        201: okResponse('Sub-category created', SubCategorySchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInCategories.CreateSubCategorySchema, req.body, reply);
        if (!wireIn) return reply;
        const flow = () => createSubCategory(deps, wireIn).map(categoryAdapters.outcomeToDb);
        return send(reply, await runEffects(flow), 201);
      },
    },
    {
      method: 'delete',
      path: '/api/categories/:name',
      tags: [CATEGORIES_TAG],
      summary: 'Delete category',
      request: { params: nameParam },
      responses: { 200: okResponse('Category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const flow = () => deleteCategory(deps, name).map(categoryAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'delete',
      path: '/api/sub-categories/:name',
      tags: [CATEGORIES_TAG],
      summary: 'Delete sub-category',
      request: { params: nameParam },
      responses: { 200: okResponse('Sub-category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const flow = () => deleteSubCategory(deps, name).map(categoryAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
  ];
};
