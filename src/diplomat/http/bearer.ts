import type { FastifyReply, FastifyRequest } from 'fastify';
import { httpStatus } from '../../common/errors.js';
import { bearerChallenge, resourceMetadataUrl } from '../../logic/auth/bearer.js';
import { resourceOrigin } from '../../logic/auth/origin.js';
import type { ChallengeableError } from '../../models/auth/errors.js';

const WWW_AUTHENTICATE = 'www-authenticate';

/**
 * Reject a request with a Bearer challenge (RFC 6750 §3, MCP authorization): the status follows the error, the
 * `WWW-Authenticate` value is built in one place (`logic/auth/bearer.ts`'s `bearerChallenge`) and only its origin is
 * resolved here, from `PUBLIC_URL` or the request's own loopback host. Shared by the auth hook and the MCP route's
 * per-tool scope check so the two can never word a challenge differently.
 */
export const rejectWithChallenge = (
  req: FastifyRequest,
  reply: FastifyReply,
  publicUrl: string | undefined,
  error: ChallengeableError,
): FastifyReply => {
  const origin = resourceOrigin(publicUrl, req.headers.host);
  const metadataUrl = origin === null ? null : resourceMetadataUrl(origin);
  return reply.header(WWW_AUTHENTICATE, bearerChallenge(error, metadataUrl)).status(httpStatus(error)).send({ error });
};
