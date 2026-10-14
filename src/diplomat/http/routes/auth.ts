import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { claimOwner, login, logout, ownerNeedsSetup } from '../../../controllers/auth.js';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { authErrors } from '../../../models/auth/errors.js';
import { AUTH_MESSAGES } from '../../../models/auth/message.js';
import { DEFAULT_LANDING_PATH } from '../../../models/auth/origin.js';
import { validation } from '../../../models/error.js';
import { LoginFormSchema, NextQuerySchema, SetupFormSchema } from '../../../wire/in/auth.js';
import { renderLoginPage, renderSetupPage } from '../authPages.js';
import { LOGIN_PATH, LOGOUT_PATH, SEE_OTHER, SETUP_PATH } from '../authPaths.js';
import type { AuthRoutesContext } from '../context.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page } from '../formPages.js';
import { clearedSessionCookie, readCookie, SESSION_COOKIE_NAME, sessionCookie } from '../cookies.js';
import { createAttemptLimiter } from '../rateLimiter.js';

const statusOf = (error: AppError): number => httpStatus(error);
const RATE_LIMITED_STATUS = statusOf(authErrors.rateLimited);
// An unparsable form is the same "validation" failure every other boundary reports.
const INVALID_FORM_STATUS = statusOf(validation([]));

const messageFor = (e: AppError): string => {
  switch (e.code) {
    case 'invalid_credentials':
      return AUTH_MESSAGES.invalidCredentials;
    case 'invalid_setup_code':
      return AUTH_MESSAGES.invalidSetupCode;
    case 'setup_unavailable':
      return AUTH_MESSAGES.setupUnavailable;
    case 'rate_limited':
      return AUTH_MESSAGES.rateLimited;
    default:
      return AUTH_MESSAGES.tryAgain;
  }
};

const nextFrom = (query: unknown): string => NextQuerySchema.safeParse(query).data?.next ?? DEFAULT_LANDING_PATH;

/**
 * `/ui/login`, `/ui/setup`, `/ui/logout` (ADR-033 §2). Browser-facing HTML, not part of the `/api` JSON
 * contract, so — like `routes/ui.ts` — these are not `RouteDefinition`s. Thin: parse the form, throttle,
 * run the `controllers/auth.ts` flow, translate to a cookie + redirect or a page.
 */
export const registerAuthRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const loginLimiter = createAttemptLimiter();
  const setupLimiter = createAttemptLimiter();

  const startSession = (reply: FastifyReply, started: { token: string; expiresAt: string }, next: string) =>
    reply.header('set-cookie', sessionCookie(started.token, ctx.secureCookie)).redirect(next, SEE_OTHER);

  void app.register(async (scope) => {
    addFormParser(scope);
    const formRoute = { bodyLimit: FORM_BODY_LIMIT_BYTES };

    scope.get(LOGIN_PATH, async (req, reply) =>
      (await ownerNeedsSetup(ctx.deps))
        ? reply.redirect(SETUP_PATH)
        : page(reply, 200, await renderLoginPage({ next: nextFrom(req.query) })),
    );

    scope.post(LOGIN_PATH, formRoute, async (req, reply) => {
      const parsed = LoginFormSchema.safeParse(req.body);
      const next = parsed.success ? parsed.data.next : DEFAULT_LANDING_PATH;
      const failLogin = async (status: number, error: string) =>
        page(reply, status, await renderLoginPage({ next, error }));
      if (!parsed.success) return failLogin(INVALID_FORM_STATUS, AUTH_MESSAGES.invalidCredentials);

      const { username } = parsed.data;
      if (loginLimiter.isLimited(req.ip, username)) {
        return failLogin(RATE_LIMITED_STATUS, AUTH_MESSAGES.rateLimited);
      }
      // Reserve the strike before the slow verification: the check above and this take no await between
      // them, so N concurrent guesses are counted as they arrive rather than all slipping past `isLimited`.
      const result = await loginLimiter.attempt(req.ip, username, () =>
        ctx.runEffects(() => login(ctx.deps, parsed.data)),
      );
      if (result.isOk()) {
        loginLimiter.recordSuccess(req.ip, username);
        return startSession(reply, result.value, next);
      }
      if (result.error.code !== authErrors.invalidCredentials.code) loginLimiter.forgive(req.ip, username);
      return failLogin(statusOf(result.error), messageFor(result.error));
    });

    scope.get(SETUP_PATH, async (_req, reply) =>
      (await ownerNeedsSetup(ctx.deps)) ? page(reply, 200, await renderSetupPage({})) : reply.redirect(LOGIN_PATH),
    );

    scope.post(SETUP_PATH, formRoute, async (req, reply) => {
      const failSetup = async (status: number, error: string) => page(reply, status, await renderSetupPage({ error }));
      const parsed = SetupFormSchema.safeParse(req.body);
      if (!parsed.success) return failSetup(INVALID_FORM_STATUS, firstIssue(parsed.error));

      const { username } = parsed.data;
      if (setupLimiter.isLimited(req.ip, username)) return failSetup(RATE_LIMITED_STATUS, AUTH_MESSAGES.rateLimited);

      const result = await setupLimiter.attempt(req.ip, username, () =>
        ctx.runEffects(() => claimOwner(ctx.deps, parsed.data)),
      );
      if (result.isOk()) {
        setupLimiter.recordSuccess(req.ip, username);
        return startSession(reply, result.value, DEFAULT_LANDING_PATH);
      }
      if (result.error.code !== authErrors.invalidSetupCode.code) setupLimiter.forgive(req.ip, username);
      return failSetup(statusOf(result.error), messageFor(result.error));
    });

    scope.post(LOGOUT_PATH, async (req, reply) => {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
      const revoked = token
        ? await ctx.runEffects(() => logout(ctx.deps, ctx.deps.secrets.hashSecret(token)))
        : undefined;
      // The cookie is only cleared once the session row is really gone: reporting a logout that did not
      // commit would leave a still-valid token (possibly copied elsewhere) behind a "logged out" screen.
      if (revoked?.isErr()) return reply.status(statusOf(revoked.error)).send({ error: revoked.error });
      return reply.header('set-cookie', clearedSessionCookie(ctx.secureCookie)).redirect(LOGIN_PATH, SEE_OTHER);
    });
  });
};

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? AUTH_MESSAGES.tryAgain;
