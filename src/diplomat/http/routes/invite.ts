import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatus, type AppError } from '../../../common/errors.js';
import { claimInvite } from '../../../controllers/auth/users.js';
import { normalizeInviteCode } from '../../../logic/auth/users.js';
import { authErrors } from '../../../models/auth/errors.js';
import { AUTH_MESSAGES } from '../../../models/auth/message.js';
import { DEFAULT_LANDING_PATH, INVITE_CODE_PARAM } from '../../../models/auth/origin.js';
import { validation } from '../../../models/error.js';
import { ClaimedCodeEchoSchema, ClaimInviteFormSchema, InviteQuerySchema } from '../../../wire/in/auth.js';
import { INVITE_PATH, SEE_OTHER } from '../auth-paths.js';
import type { AuthRoutesContext } from '../context.js';
import { sessionCookie } from '../cookies.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, SECRET_URL_HEADERS, page } from '../form-pages.js';
import { createAttemptLimiter, type AttemptLimiter } from '../rate-limiter.js';
import { renderInvitePage } from '../user-pages.js';

const INVALID_FORM_STATUS = httpStatus(validation([]));

// What each refusal says on the claim page; every other failure is the generic "try again".
const REFUSAL_MESSAGE: Readonly<Partial<Record<AppError['code'], string>>> = {
  [authErrors.invalidInvite.code]: AUTH_MESSAGES.invalidInvite,
  [authErrors.rateLimited.code]: AUTH_MESSAGES.rateLimited,
};

const messageFor = (error: AppError): string => REFUSAL_MESSAGE[error.code] ?? AUTH_MESSAGES.tryAgain;

// The link carries the code in its query string, so every answer from this page — the form and its failures — keeps
// the path and query out of any `Referer`.
const claimPage = async (reply: FastifyReply, status: number, fields: { code: string; error?: string }) =>
  page(reply, status, await renderInvitePage(fields), SECRET_URL_HEADERS);

const showInvite = async (req: FastifyRequest, reply: FastifyReply) =>
  claimPage(reply, 200, { code: InviteQuerySchema.safeParse(req.query).data?.[INVITE_CODE_PARAM] ?? '' });

const submitClaim =
  (ctx: AuthRoutesContext, limiter: AttemptLimiter) => async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ClaimInviteFormSchema.safeParse(req.body);
    const { code } = ClaimedCodeEchoSchema.parse(req.body ?? {});
    if (!parsed.success) {
      return claimPage(reply, INVALID_FORM_STATUS, {
        code,
        error: parsed.error.issues[0]?.message ?? AUTH_MESSAGES.tryAgain,
      });
    }

    // Keyed by the code (hashed in memory), alongside the client address: guessing one invite is limited as a whole.
    const key = ctx.deps.secrets.hashSecret(normalizeInviteCode(parsed.data.code));
    if (limiter.isLimited(req.ip, key)) {
      return claimPage(reply, httpStatus(authErrors.rateLimited), { code, error: AUTH_MESSAGES.rateLimited });
    }
    const claimed = await limiter.attempt(req.ip, key, () => ctx.runEffects(() => claimInvite(ctx.deps, parsed.data)));
    if (claimed.isErr()) {
      if (claimed.error.code !== authErrors.invalidInvite.code) limiter.forgive(req.ip, key);
      return claimPage(reply, httpStatus(claimed.error), { code, error: messageFor(claimed.error) });
    }
    limiter.recordSuccess(req.ip, key);
    return reply
      .header('set-cookie', sessionCookie(claimed.value.token, ctx.secureCookie))
      .redirect(DEFAULT_LANDING_PATH, SEE_OTHER);
  };

/**
 * `/ui/access/invite`: where an invited person chooses their password. Public like `/ui/setup` — they have
 * no login yet — so it is rate-limited the same way and its POST is Origin-checked whenever a browser declares one. The
 * code may come in the link or be typed; it is single-use, expires, and is never logged. On success the person lands
 * signed in. Thin: parse the form, throttle, run the `controllers/auth/users.ts` flow, set the cookie.
 */
export const registerInviteRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const limiter = createAttemptLimiter();

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.get(INVITE_PATH, showInvite);
    scope.post(INVITE_PATH, { bodyLimit: FORM_BODY_LIMIT_BYTES }, submitClaim(ctx, limiter));
  });
};
