import type { FastifyInstance, FastifyReply } from 'fastify';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { approveGrant, denyGrant, findConsent } from '../../../controllers/grants.js';
import { AUTH_MESSAGES, authErrors, CONNECT_CODE_PARAM, type GrantChannel } from '../../../models/auth.js';
import { validation } from '../../../models/error.js';
import { ConnectDecision, ConnectFormSchema, ConnectQuerySchema } from '../../../wire/in/auth.js';
import { CONNECT_PATH } from '../authPaths.js';
import type { AuthRoutesContext } from '../context.js';
import { renderConnectPage, renderConnectResultPage } from '../connectPages.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page } from '../formPages.js';
import {
  createRateLimiter,
  LOGIN_ATTEMPT_WINDOW_MS,
  MAX_CODE_LOOKUP_FAILURES_PER_IP,
  type RateLimiter,
} from '../rateLimiter.js';
import { requireSession } from '../session.js';

const OK_STATUS = 200;
const INVALID_STATUS = httpStatus(authErrors.invalidGrant);
const INVALID_FORM_STATUS = httpStatus(validation([]));
const RATE_LIMITED_STATUS = httpStatus(authErrors.rateLimited);

const HEADINGS = {
  approved: 'Approved',
  denied: 'Request denied',
  invalid: 'Not valid',
  limited: 'Slow down',
} as const;
const MESSAGES = {
  approved: 'Approved. You can go back to your Claude session — it will pick the sign-in up in a moment.',
  denied: 'Denied. The client was not signed in.',
} as const;

/**
 * `/ui/connect` (ADR-034 §3): the consent page for a stdio (or `fintrack login`) sign-in. Browser HTML behind the
 * session cookie and the hook's CSRF check — a link that merely carries a code grants nothing, and a bearer token can
 * never approve one. Thin: parse, throttle, run the `controllers/grants.ts` flow, render a page. An unknown, expired
 * or already-answered code all read the same, and a run of them from one address is throttled.
 */
export const registerConnectRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const lookups: RateLimiter = createRateLimiter({
    windowMs: LOGIN_ATTEMPT_WINDOW_MS,
    maxFailures: MAX_CODE_LOOKUP_FAILURES_PER_IP,
    now: Date.now,
  });

  const result = async (
    reply: FastifyReply,
    status: number,
    heading: string,
    message: string,
    channel?: GrantChannel,
  ) => page(reply, status, await renderConnectResultPage({ heading, message, channel }));

  const invalid = (reply: FastifyReply, ip: string) => {
    lookups.recordFailure(ip);
    return result(reply, INVALID_STATUS, HEADINGS.invalid, AUTH_MESSAGES.invalidGrant);
  };

  const limited = (reply: FastifyReply) =>
    result(reply, RATE_LIMITED_STATUS, HEADINGS.limited, AUTH_MESSAGES.rateLimited);

  const failed = (reply: FastifyReply, ip: string, error: AppError) => {
    if (error.code === authErrors.invalidGrant.code) return invalid(reply, ip);
    const status = error.code === validation([]).code ? INVALID_FORM_STATUS : httpStatus(error);
    return result(reply, status, HEADINGS.invalid, AUTH_MESSAGES.tryAgain);
  };

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.addHook('preHandler', requireSession);

    scope.get(CONNECT_PATH, async (req, reply) => {
      const code = ConnectQuerySchema.safeParse(req.query).data?.[CONNECT_CODE_PARAM];
      if (lookups.isLimited(req.ip)) return limited(reply);
      const consent = code === undefined ? null : await findConsent(ctx.deps, req.principal!.userId, code);
      if (consent === null) return invalid(reply, req.ip);
      return page(reply, OK_STATUS, await renderConnectPage(consent));
    });

    scope.post(CONNECT_PATH, { bodyLimit: FORM_BODY_LIMIT_BYTES }, async (req, reply) => {
      const parsed = ConnectFormSchema.safeParse(req.body);
      if (!parsed.success) return result(reply, INVALID_FORM_STATUS, HEADINGS.invalid, AUTH_MESSAGES.tryAgain);
      if (lookups.isLimited(req.ip)) return limited(reply);

      const { decision, code, access, duration } = parsed.data;
      const principal = req.principal!;
      const consent = await findConsent(ctx.deps, principal.userId, code);
      if (consent === null) return invalid(reply, req.ip);
      const { channel } = consent.request;
      const answered =
        decision === ConnectDecision.enum.approve
          ? await ctx.runEffects(() => approveGrant(ctx.deps, principal, { userCode: code, access, duration }))
          : await ctx.runEffects(() => denyGrant(ctx.deps, principal, code));
      if (answered.isErr()) return failed(reply, req.ip, answered.error);
      return decision === ConnectDecision.enum.approve
        ? result(reply, OK_STATUS, HEADINGS.approved, MESSAGES.approved, channel)
        : result(reply, OK_STATUS, HEADINGS.denied, MESSAGES.denied, channel);
    });
  });
};
