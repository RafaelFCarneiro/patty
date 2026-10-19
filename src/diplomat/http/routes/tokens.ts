import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { createToken, listTokens, revokeToken } from '../../../controllers/accessTokens.js';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { authErrors } from '../../../models/auth/errors.js';
import { UserRole } from '../../../models/auth/owner.js';
import type { Principal } from '../../../models/auth/principal.js';
import { AUTH_MESSAGES } from '../../../models/auth/message.js';
import { validation } from '../../../models/error.js';
import { CreateTokenFormSchema } from '../../../wire/in/auth.js';
import { SEE_OTHER, TOKEN_REVOKE_PATH, TOKENS_PATH } from '../authPaths.js';
import type { AuthRoutesContext } from '../context.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page } from '../formPages.js';
import { createAttemptLimiter } from '../rateLimiter.js';
import { requireSession } from '../session.js';
import { renderTokenCreatedPage, renderTokensPage } from '../tokenPages.js';

const INVALID_FORM_STATUS = httpStatus(validation([]));
// A wrong step-up password is a refused action inside a valid session, not a missing credential.
const STEP_UP_REFUSED_STATUS = httpStatus(authErrors.sessionRequired);
const RATE_LIMITED_STATUS = httpStatus(authErrors.rateLimited);

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? AUTH_MESSAGES.tryAgain;

type Limiter = ReturnType<typeof createAttemptLimiter>;

const showTokens = async (
  ctx: AuthRoutesContext,
  reply: FastifyReply,
  principal: Principal,
  status: number,
  error?: string,
) =>
  page(
    reply,
    status,
    await renderTokensPage({
      tokens: await listTokens(ctx.deps, principal.userId),
      // Only an administrator is shown the way to user management; to anyone else the page does not exist.
      showUsersLink: principal.role === UserRole.enum.admin,
      error,
    }),
  );

const listPage = (ctx: AuthRoutesContext) => (req: FastifyRequest, reply: FastifyReply) =>
  showTokens(ctx, reply, req.principal!, 200);

// A wrong step-up password is a refused action inside a valid session; anything else is a generic failure.
const refusalOf = (error: AppError): { status: number; message: string } =>
  error.code === authErrors.invalidCredentials.code
    ? { status: STEP_UP_REFUSED_STATUS, message: AUTH_MESSAGES.invalidPassword }
    : { status: httpStatus(error), message: AUTH_MESSAGES.tryAgain };

const createPage = (ctx: AuthRoutesContext, limiter: Limiter) => async (req: FastifyRequest, reply: FastifyReply) => {
  const principal = req.principal!;
  const { userId } = principal;
  const parsed = CreateTokenFormSchema.safeParse(req.body);
  if (!parsed.success) return showTokens(ctx, reply, principal, INVALID_FORM_STATUS, firstIssue(parsed.error));
  if (limiter.isLimited(req.ip, userId)) {
    return showTokens(ctx, reply, principal, RATE_LIMITED_STATUS, AUTH_MESSAGES.rateLimited);
  }
  const created = await limiter.attempt(req.ip, userId, () =>
    ctx.runEffects(() => createToken(ctx.deps, principal, parsed.data)),
  );
  if (created.isErr()) {
    if (created.error.code !== authErrors.invalidCredentials.code) limiter.forgive(req.ip, userId);
    const { status, message } = refusalOf(created.error);
    return showTokens(ctx, reply, principal, status, message);
  }
  limiter.recordSuccess(req.ip, userId);
  return page(reply, 200, await renderTokenCreatedPage(created.value));
};

const revokePage = (ctx: AuthRoutesContext) => async (req: FastifyRequest, reply: FastifyReply) => {
  const principal = req.principal!;
  const { userId } = principal;
  const { id } = req.params as { id: string };
  const revoked = await ctx.runEffects(() => revokeToken(ctx.deps, userId, id));
  return revoked.isErr()
    ? showTokens(ctx, reply, principal, httpStatus(revoked.error), AUTH_MESSAGES.unknownToken)
    : reply.redirect(TOKENS_PATH, SEE_OTHER);
};

/**
 * `/ui/access/tokens` (ADR-033 §3): the personal-access-token pages. Browser HTML behind the session cookie and the
 * hook's CSRF check — a bearer token is never accepted on `/ui`, so a token can never mint, widen or revoke
 * another. Thin: parse the form, run the `controllers/accessTokens.ts` flow, render a page. The plaintext token
 * is rendered once, by the response to the create POST, and nowhere else.
 */
export const registerTokenRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  // Guessing the step-up password costs the same strikes as guessing it at /ui/login.
  const passwordLimiter = createAttemptLimiter();
  const formRoute = { bodyLimit: FORM_BODY_LIMIT_BYTES };

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.addHook('preHandler', requireSession);
    scope.get(TOKENS_PATH, listPage(ctx));
    scope.post(TOKENS_PATH, formRoute, createPage(ctx, passwordLimiter));
    scope.post(TOKEN_REVOKE_PATH, formRoute, revokePage(ctx));
  });
};
