import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { createToken, listTokens, revokeToken } from '../../../controllers/accessTokens.js';
import { httpStatus } from '../../../common/errors.js';
import { AUTH_MESSAGES, authErrors, PrincipalVia } from '../../../models/auth.js';
import { validation } from '../../../models/error.js';
import { CreateTokenFormSchema } from '../../../wire/in/auth.js';
import { SEE_OTHER, TOKEN_REVOKE_PATH, TOKENS_PATH } from '../authPaths.js';
import type { AuthRoutesContext } from '../context.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page } from '../formPages.js';
import { createAttemptLimiter } from '../rateLimiter.js';
import { renderTokenCreatedPage, renderTokensPage } from '../tokenPages.js';

const INVALID_FORM_STATUS = httpStatus(validation([]));
// A wrong step-up password is a refused action inside a valid session, not a missing credential.
const STEP_UP_REFUSED_STATUS = httpStatus(authErrors.sessionRequired);
const RATE_LIMITED_STATUS = httpStatus(authErrors.rateLimited);

// The hook only authenticates a bearer on /api and /mcp, so a token should never reach these pages — but "a token
// can never mint or widen another token" is too important to rest on path routing alone, so each route also
// insists on a browser session.
const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
  req.principal?.via === PrincipalVia.enum.session
    ? undefined
    : reply.status(httpStatus(authErrors.sessionRequired)).send({ error: authErrors.sessionRequired });

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? AUTH_MESSAGES.tryAgain;

/**
 * `/ui/access/tokens` (ADR-033 §3): the personal-access-token pages. Browser HTML behind the session cookie and the
 * hook's CSRF check — a bearer token is never accepted on `/ui`, so a token can never mint, widen or revoke
 * another. Thin: parse the form, run the `controllers/accessTokens.ts` flow, render a page. The plaintext token
 * is rendered once, by the response to the create POST, and nowhere else.
 */
export const registerTokenRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const showTokens = async (userId: string, status: number, error?: string) =>
    renderTokensPage({ tokens: await listTokens(ctx.deps, userId), error }).then((html) => ({ status, html }));

  // Guessing the step-up password costs the same strikes as guessing it at /ui/login.
  const passwordLimiter = createAttemptLimiter();

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.addHook('preHandler', requireSession);
    const formRoute = { bodyLimit: FORM_BODY_LIMIT_BYTES };

    scope.get(TOKENS_PATH, async (req, reply) => {
      const { status, html } = await showTokens(req.principal!.userId, 200);
      return page(reply, status, html);
    });

    scope.post(TOKENS_PATH, formRoute, async (req, reply) => {
      const { userId } = req.principal!;
      const parsed = CreateTokenFormSchema.safeParse(req.body);
      if (!parsed.success) {
        const { status, html } = await showTokens(userId, INVALID_FORM_STATUS, firstIssue(parsed.error));
        return page(reply, status, html);
      }
      if (passwordLimiter.isLimited(req.ip, userId)) {
        const { status, html } = await showTokens(userId, RATE_LIMITED_STATUS, AUTH_MESSAGES.rateLimited);
        return page(reply, status, html);
      }
      const created = await passwordLimiter.attempt(req.ip, userId, () =>
        ctx.runEffects(() => createToken(ctx.deps, userId, parsed.data)),
      );
      if (created.isErr()) {
        const wrongPassword = created.error.code === authErrors.invalidCredentials.code;
        if (!wrongPassword) passwordLimiter.forgive(req.ip, userId);
        const { status, html } = await showTokens(
          userId,
          wrongPassword ? STEP_UP_REFUSED_STATUS : httpStatus(created.error),
          wrongPassword ? AUTH_MESSAGES.invalidPassword : AUTH_MESSAGES.tryAgain,
        );
        return page(reply, status, html);
      }
      passwordLimiter.recordSuccess(req.ip, userId);
      return page(reply, 200, await renderTokenCreatedPage(created.value));
    });

    scope.post(TOKEN_REVOKE_PATH, formRoute, async (req, reply) => {
      const { userId } = req.principal!;
      const { id } = req.params as { id: string };
      const revoked = await ctx.runEffects(() => revokeToken(ctx.deps, userId, id));
      if (revoked.isErr()) {
        const { status, html } = await showTokens(userId, httpStatus(revoked.error), AUTH_MESSAGES.unknownToken);
        return page(reply, status, html);
      }
      return reply.redirect(TOKENS_PATH, SEE_OTHER);
    });
  });
};
