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
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import {
  conflict409,
  invalidQueryResponse,
  nameParam,
  notFound404,
  parse,
  pathParam,
  send,
  validation422,
} from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const CATEGORIES_TAG = 'Categories';

const listCategoriesRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/categories',
  tags: [CATEGORIES_TAG],
  summary: 'List categories',
  responses: { 200: okResponse('Categories', z.array(CategorySchema)) },
  handler: async (_req, _reply, scope) => listCategories(scope().deps),
};

const createCategoryRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
  path: '/api/categories',
  tags: [CATEGORIES_TAG],
  summary: 'Create category',
  request: { body: jsonBody(wireInCategories.CreateCategorySchema) },
  responses: { 201: okResponse('Category created', CategorySchema), 409: conflict409, 422: validation422 },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const wireIn = parse(wireInCategories.CreateCategorySchema, req.body, reply);
    if (!wireIn) return reply;
    const flow = () => createCategory(deps, categoryAdapters.wireInToModel(wireIn)).map(categoryAdapters.outcomeToDb);
    return send(reply, await runEffects(flow), 201);
  },
};

const listSubCategoriesRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/sub-categories',
  tags: [CATEGORIES_TAG],
  summary: 'List sub-categories',
  request: { query: wireInCategories.SubCategoriesQuerySchema },
  responses: { 200: okResponse('Sub-categories', z.array(SubCategorySchema)), 422: validation422 },
  handler: async (req, reply, scope) => {
    const query = wireInCategories.SubCategoriesQuerySchema.safeParse(req.query);
    if (!query.success) return invalidQueryResponse(reply);
    return reply.send(await listSubCategories(scope().deps, query.data.parentId));
  },
};

const createSubCategoryRoute: RouteDefinition = {
  method: 'post',
  scope: WRITE_SCOPE,
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
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const wireIn = parse(wireInCategories.CreateSubCategorySchema, req.body, reply);
    if (!wireIn) return reply;
    const flow = () => createSubCategory(deps, wireIn).map(categoryAdapters.outcomeToDb);
    return send(reply, await runEffects(flow), 201);
  },
};

const deleteCategoryRoute: RouteDefinition = {
  method: 'delete',
  scope: WRITE_SCOPE,
  path: '/api/categories/:name',
  tags: [CATEGORIES_TAG],
  summary: 'Delete category',
  request: { params: nameParam },
  responses: { 200: okResponse('Category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const flow = () => deleteCategory(deps, pathParam(req, 'name')).map(categoryAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

const deleteSubCategoryRoute: RouteDefinition = {
  method: 'delete',
  scope: WRITE_SCOPE,
  path: '/api/sub-categories/:name',
  tags: [CATEGORIES_TAG],
  summary: 'Delete sub-category',
  request: { params: nameParam },
  responses: { 200: okResponse('Sub-category deleted', DeletedOut), 404: notFound404, 409: conflict409 },
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const flow = () => deleteSubCategory(deps, pathParam(req, 'name')).map(categoryAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

export const categoryRoutes: RouteDefinition[] = [
  listCategoriesRoute,
  createCategoryRoute,
  listSubCategoriesRoute,
  createSubCategoryRoute,
  deleteCategoryRoute,
  deleteSubCategoryRoute,
];
