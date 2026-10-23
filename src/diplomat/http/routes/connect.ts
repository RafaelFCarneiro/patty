import { err } from 'neverthrow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { approveGrant, denyGrant, findConsent } from '../../../controllers/grants.js';
import { authErrors } from '../../../models/auth/errors.js';
import type { ApproveGrantInput, Consent } from '../../../models/auth/grant.js';
import { AUTH_MESSAGES } from '../../../models/auth/message.js';
import { CONNECT_CODE_PARAM } from '../../../models/auth/origin.js';
import { validation } from '../../../models/error.js';
import { ConnectDecision, ConnectFormSchema, ConnectQuerySchema } from '../../../wire/in/auth.js';
import { CONNECT_PATH } from '../auth-paths.js';
import type { AuthRoutesContext } from '../context.js';
import { renderConnectPage, renderConnectResultPage } from '../connect-pages.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page, STEP_UP_REFUSED_STATUS } from '../form-pages.js';
import {
  createAttemptLimiter,
  createRateLimiter,
  type AttemptLimiter,
  LOGIN_ATTEMPT_WINDOW_MS,
  MAX_CODE_LOOKUP_FAILURES_PER_IP,
  type RateLimiter,
} from '../rate-limiter.js';
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

type ConnectPages = {
  ctx: AuthRoutesContext;
  lookups: RateLimiter;
  /** Guessing the approver's password gets the login page's limits, on a counter of its own (as on the token page). */
  passwords: AttemptLimiter;
};

const result = async (
  reply: FastifyReply,
  status: number,
  heading: string,
  message: string,
  options: { answered?: boolean } = {},
) => page(reply, status, await renderConnectResultPage({ heading, message, answered: options.answered }));

const invalid = (reply: FastifyReply) => result(reply, INVALID_STATUS, HEADINGS.invalid, AUTH_MESSAGES.invalidGrant);

const limited = (reply: FastifyReply) =>
  result(reply, RATE_LIMITED_STATUS, HEADINGS.limited, AUTH_MESSAGES.rateLimited);

const failed = ({ lookups }: ConnectPages, reply: FastifyReply, ip: string, error: AppError) => {
  if (error.code === authErrors.invalidGrant.code) {
    lookups.recordFailure(ip); // answered by someone else between the lookup and the decision: a miss after all
    return invalid(reply);
  }
  const status = error.code === validation([]).code ? INVALID_FORM_STATUS : httpStatus(error);
  return result(reply, status, HEADINGS.invalid, AUTH_MESSAGES.tryAgain);
};

// The strike is taken BEFORE the awaited lookup and given back for a valid code: recording the miss only afterwards
// would let a burst of concurrent guesses all see an empty limiter (the login pages reserve the same way).
const lookUp = async ({ ctx, lookups }: ConnectPages, ip: string, userId: string, code: string) => {
  lookups.recordFailure(ip);
  const consent = await findConsent(ctx.deps, userId, code);
  if (consent !== null) lookups.forgive(ip);
  return consent;
};

const showConsent = (pages: ConnectPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const code = ConnectQuerySchema.safeParse(req.query).data?.[CONNECT_CODE_PARAM];
  if (pages.lookups.isLimited(req.ip)) return limited(reply);
  const consent = code === undefined ? null : await lookUp(pages, req.ip, req.principal!.userId, code);
  if (consent === null) return invalid(reply);
  return page(reply, OK_STATUS, await renderConnectPage(consent));
};

const isWrongPassword = (error: AppError): boolean => error.code === authErrors.invalidCredentials.code;

// Only an approval re-asks the password; denying grants nothing. The strike is taken before the slow verification.
const approve = async ({ ctx, passwords }: ConnectPages, req: FastifyRequest, input: ApproveGrantInput) => {
  const { userId } = req.principal!;
  if (passwords.isLimited(req.ip, userId)) return err(authErrors.rateLimited);
  const approved = await passwords.attempt(req.ip, userId, () =>
    ctx.runEffects(() => approveGrant(ctx.deps, req.principal!, input)),
  );
  if (approved.isOk()) passwords.recordSuccess(req.ip, userId);
  else if (!isWrongPassword(approved.error)) passwords.forgive(req.ip, userId);
  return approved;
};

const answerGrant = (pages: ConnectPages, req: FastifyRequest, decision: ConnectDecision, input: ApproveGrantInput) =>
  decision === ConnectDecision.enum.approve
    ? approve(pages, req, input)
    : pages.ctx.runEffects(() => denyGrant(pages.ctx.deps, req.principal!, input.userCode));

const answeredPage = (reply: FastifyReply, decision: ConnectDecision) =>
  decision === ConnectDecision.enum.approve
    ? result(reply, OK_STATUS, HEADINGS.approved, MESSAGES.approved, { answered: true })
    : result(reply, OK_STATUS, HEADINGS.denied, MESSAGES.denied, { answered: true });

// The request stays pending: the same consent page again, with the person's choices kept and the password field empty.
const retryConsent = async (reply: FastifyReply, consent: Consent, input: ApproveGrantInput) =>
  page(
    reply,
    STEP_UP_REFUSED_STATUS,
    await renderConnectPage({
      ...consent,
      choice: { access: input.access, duration: input.duration },
      error: AUTH_MESSAGES.invalidPassword,
    }),
  );

const submitDecision = (pages: ConnectPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = ConnectFormSchema.safeParse(req.body);
  if (!parsed.success) return result(reply, INVALID_FORM_STATUS, HEADINGS.invalid, AUTH_MESSAGES.tryAgain);
  if (pages.lookups.isLimited(req.ip)) return limited(reply);

  const { decision, code, access, duration, password } = parsed.data;
  const consent = await lookUp(pages, req.ip, req.principal!.userId, code);
  if (consent === null) return invalid(reply);
  const input: ApproveGrantInput = { userCode: code, access, duration, password };
  const answered = await answerGrant(pages, req, decision, input);
  if (answered.isOk()) return answeredPage(reply, decision);
  if (isWrongPassword(answered.error)) return retryConsent(reply, consent, input);
  return answered.error.code === authErrors.rateLimited.code
    ? limited(reply)
    : failed(pages, reply, req.ip, answered.error);
};

/**
 * `/ui/connect` (ADR-034 §3): the consent page for a stdio (or `fintrack login`) sign-in. Browser HTML behind the
 * session cookie and the hook's CSRF check — a link that merely carries a code grants nothing, and a bearer token can
 * never approve one. Thin: parse, throttle, run the `controllers/grants.ts` flow, render a page. An unknown, expired
 * or already-answered code all read the same, and a run of them from one address is throttled.
 */
export const registerConnectRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const pages: ConnectPages = {
    ctx,
    passwords: createAttemptLimiter(),
    lookups: createRateLimiter({
      windowMs: LOGIN_ATTEMPT_WINDOW_MS,
      maxFailures: MAX_CODE_LOOKUP_FAILURES_PER_IP,
      now: Date.now,
    }),
  };

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.addHook('preHandler', requireSession);
    scope.get(CONNECT_PATH, showConsent(pages));
    scope.post(CONNECT_PATH, { bodyLimit: FORM_BODY_LIMIT_BYTES }, submitDecision(pages));
  });
};
