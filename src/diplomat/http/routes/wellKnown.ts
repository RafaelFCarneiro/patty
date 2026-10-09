import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatus } from '../../../common/errors.js';
import { protectedResourceMetadata, resourceOrigin } from '../../../logic/auth.js';
import { authErrors, MCP_PRM_PATH, PRM_WELL_KNOWN_PATH, READ_SCOPE } from '../../../models/auth.js';
import { CACHE_CONTROL_NO_CACHE } from '../respond.js';

/**
 * Protected Resource Metadata (RFC 9728 §3, MCP authorization): the document an unauthenticated client finds
 * through the 401 challenge's `resource_metadata`. Served at the path-inserted URI for resource `<origin>/mcp`
 * and at the bare well-known URI (same document); both are in `PUBLIC_ROUTES`. Only mounted when auth is
 * `required` — with auth disabled there is no authorization to describe. The origin is `PUBLIC_URL`, else the
 * request's own loopback origin; if neither is known the document would name a resource we cannot vouch for, so
 * it is a 404 with a hint.
 */
export const registerProtectedResourceMetadataRoutes = (app: FastifyInstance, publicUrl: string | undefined): void => {
  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = resourceOrigin(publicUrl, req.headers.host);
    if (origin === null) {
      return reply.status(httpStatus(authErrors.metadataUnavailable)).send({ error: authErrors.metadataUnavailable });
    }
    return reply.header('cache-control', CACHE_CONTROL_NO_CACHE).send(protectedResourceMetadata(origin));
  };
  const options = { config: { scope: READ_SCOPE } };
  app.get(PRM_WELL_KNOWN_PATH, options, serve);
  app.get(MCP_PRM_PATH, options, serve);
};
