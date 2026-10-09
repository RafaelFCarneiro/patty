import { z } from 'zod';
import * as tagAdapters from '../../../adapters/tags.js';
import { createTag, deleteTag, listTags } from '../../../controllers/tags.js';
import { TagSchema } from '../../../models/tag.js';
import { CreateTagSchema } from '../../../wire/in/tags.js';
import { DeletedOut } from '../../../wire/out/common.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, idParam, parse, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth.js';

const TAGS_TAG = 'Tags';

export const tagRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'get',
      scope: READ_SCOPE,
      path: '/api/tags',
      tags: [TAGS_TAG],
      summary: 'List tags',
      responses: { 200: okResponse('Tags', z.array(TagSchema)) },
      handler: async () => listTags(deps),
    },
    {
      method: 'post',
      scope: WRITE_SCOPE,
      path: '/api/tags',
      tags: [TAGS_TAG],
      summary: 'Create tag',
      request: { body: jsonBody(CreateTagSchema) },
      responses: { 201: okResponse('Tag created', TagSchema), 409: conflict409, 422: validation422 },
      handler: async (req, reply) => {
        const input = parse(CreateTagSchema, req.body, reply);
        if (!input) return reply;
        const flow = () => createTag(deps, input.name).map(tagAdapters.outcomeToDb);
        return send(reply, await runEffects(flow), 201);
      },
    },
    {
      method: 'delete',
      scope: WRITE_SCOPE,
      path: '/api/tags/:id',
      tags: [TAGS_TAG],
      summary: 'Delete tag',
      request: { params: idParam },
      responses: { 200: okResponse('Tag deleted', DeletedOut) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const flow = () => deleteTag(deps, id).map(tagAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
  ];
};
