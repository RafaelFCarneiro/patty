import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { err, type ResultAsync } from 'neverthrow';
import type { z } from 'zod';
import { httpStatus, type AppError } from '../../../common/errors.js';
import {
  currentSignInCap,
  disableUser,
  enableUser,
  inviteUser,
  listUsers,
  reissueInvite,
  setRole,
  setSignInCap,
} from '../../../controllers/users.js';
import { inviteLink } from '../../../logic/auth/users.js';
import { resourceOrigin } from '../../../logic/auth/origin.js';
import { authErrors } from '../../../models/auth/errors.js';
import { AUTH_MESSAGES } from '../../../models/auth/message.js';
import type { Actor, IssuedInvite } from '../../../models/auth/users.js';
import { validation } from '../../../models/error.js';
import {
  InviteUserFormSchema,
  SetRoleFormSchema,
  SignInCapFormSchema,
  StepUpFormSchema,
  UserParamsSchema,
} from '../../../wire/in/auth.js';
import {
  SEE_OTHER,
  USER_DISABLE_PATH,
  USER_ENABLE_PATH,
  USER_REISSUE_PATH,
  USER_ROLE_PATH,
  USERS_CAP_PATH,
  USERS_PATH,
} from '../authPaths.js';
import type { AuthRoutesContext } from '../context.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page } from '../formPages.js';
import { createAttemptLimiter, type AttemptLimiter } from '../rateLimiter.js';
import { requireAdmin, requireSession } from '../session.js';
import { renderInvitedPage, renderUsersPage } from '../userPages.js';

const INVALID_FORM_STATUS = httpStatus(validation([]));
// A wrong step-up password is a refused action inside a valid session, not a missing credential.
const STEP_UP_REFUSED_STATUS = httpStatus(authErrors.sessionRequired);

// What each refusal says on this edge. The domain's messages are neutral; the next step is worded here, in the page's
// own vocabulary (a button on a row), never in the domain's.
const REFUSAL_MESSAGE: Readonly<Partial<Record<AppError['code'], string>>> = {
  invalid_credentials: AUTH_MESSAGES.invalidPassword,
  username_taken: AUTH_MESSAGES.usernameTaken,
  cannot_change_self: AUTH_MESSAGES.cannotChangeSelf,
  last_admin: `${AUTH_MESSAGES.lastAdmin} Make another user an administrator first.`,
  user_disabled: `${AUTH_MESSAGES.userDisabled} Use the Enable button on that row.`,
  unknown_user: AUTH_MESSAGES.unknownUser,
  rate_limited: AUTH_MESSAGES.rateLimited,
};

const refusalOf = (error: AppError): { status: number; message: string } => ({
  status: error.code === authErrors.invalidCredentials.code ? STEP_UP_REFUSED_STATUS : httpStatus(error),
  message: REFUSAL_MESSAGE[error.code] ?? AUTH_MESSAGES.tryAgain,
});

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? AUTH_MESSAGES.tryAgain;

const sessionActor = (req: FastifyRequest, password?: string): Actor => ({
  kind: 'session',
  principal: req.principal!,
  password,
});

type UserPages = { ctx: AuthRoutesContext; passwords: AttemptLimiter };

const showUsers = async (pages: UserPages, req: FastifyRequest, reply: FastifyReply, status = 200, error?: string) => {
  const { ctx } = pages;
  const [users, cap] = [await listUsers(ctx.deps, sessionActor(req)), await currentSignInCap(ctx.deps)];
  if (users.isErr()) return reply.status(httpStatus(users.error)).send({ error: users.error });
  return page(reply, status, await renderUsersPage({ users: users.value, cap, error }));
};

const refused = (pages: UserPages, req: FastifyRequest, reply: FastifyReply, error: AppError) => {
  const { status, message } = refusalOf(error);
  return showUsers(pages, req, reply, status, message);
};

/**
 * Runs one step-up action: guessing the admin's password costs the same strikes as guessing it at `/ui/login`, a
 * wrong one counts and a right one clears them. The strike is taken before the slow verification.
 */
const attemptAs = async <T>(
  pages: UserPages,
  req: FastifyRequest,
  password: string,
  run: (actor: Actor) => ResultAsync<T, AppError>,
) => {
  const key = req.principal!.userId;
  if (pages.passwords.isLimited(req.ip, key)) return err(authErrors.rateLimited);
  const result = await pages.passwords.attempt(req.ip, key, () => run(sessionActor(req, password)));
  if (result.isOk()) pages.passwords.recordSuccess(req.ip, key);
  else if (result.error.code !== authErrors.invalidCredentials.code) pages.passwords.forgive(req.ip, key);
  return result;
};

const invitedPage = async (
  pages: UserPages,
  req: FastifyRequest,
  reply: FastifyReply,
  heading: string,
  issued: IssuedInvite,
) => {
  const origin = resourceOrigin(pages.ctx.publicUrl, req.headers.host);
  const link = origin === null ? null : inviteLink(origin, issued.code);
  return page(reply, 200, await renderInvitedPage({ heading, issued, link }));
};

const listPage = (pages: UserPages) => (req: FastifyRequest, reply: FastifyReply) => showUsers(pages, req, reply);

const invitePage = (pages: UserPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = InviteUserFormSchema.safeParse(req.body);
  if (!parsed.success) return showUsers(pages, req, reply, INVALID_FORM_STATUS, firstIssue(parsed.error));
  const { password, ...input } = parsed.data;
  const issued = await attemptAs(pages, req, password, (actor) =>
    pages.ctx.runEffects(() => inviteUser(pages.ctx.deps, actor, input)),
  );
  return issued.isErr()
    ? refused(pages, req, reply, issued.error)
    : invitedPage(pages, req, reply, 'Invite created', issued.value);
};

const reissuePage = (pages: UserPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const params = UserParamsSchema.safeParse(req.params);
  const parsed = StepUpFormSchema.safeParse(req.body);
  if (!params.success || !parsed.success)
    return showUsers(pages, req, reply, INVALID_FORM_STATUS, AUTH_MESSAGES.tryAgain);
  const issued = await attemptAs(pages, req, parsed.data.password, (actor) =>
    pages.ctx.runEffects(() => reissueInvite(pages.ctx.deps, actor, params.data.id)),
  );
  return issued.isErr()
    ? refused(pages, req, reply, issued.error)
    : invitedPage(pages, req, reply, 'New invite', issued.value);
};

const disablePage = (pages: UserPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const params = UserParamsSchema.safeParse(req.params);
  const parsed = StepUpFormSchema.safeParse(req.body);
  if (!params.success || !parsed.success)
    return showUsers(pages, req, reply, INVALID_FORM_STATUS, AUTH_MESSAGES.tryAgain);
  const changed = await attemptAs(pages, req, parsed.data.password, (actor) =>
    pages.ctx.runEffects(() => disableUser(pages.ctx.deps, actor, params.data.id)),
  );
  return changed.isErr() ? refused(pages, req, reply, changed.error) : reply.redirect(USERS_PATH, SEE_OTHER);
};

// Enabling only restores the ability to log in, so it does not re-ask the password.
const enablePage = (pages: UserPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const params = UserParamsSchema.safeParse(req.params);
  if (!params.success) return showUsers(pages, req, reply, INVALID_FORM_STATUS, AUTH_MESSAGES.tryAgain);
  const changed = await pages.ctx.runEffects(() => enableUser(pages.ctx.deps, sessionActor(req), params.data.id));
  return changed.isErr() ? refused(pages, req, reply, changed.error) : reply.redirect(USERS_PATH, SEE_OTHER);
};

const rolePage = (pages: UserPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const params = UserParamsSchema.safeParse(req.params);
  const parsed = SetRoleFormSchema.safeParse(req.body);
  if (!params.success || !parsed.success)
    return showUsers(pages, req, reply, INVALID_FORM_STATUS, AUTH_MESSAGES.tryAgain);
  const changed = await attemptAs(pages, req, parsed.data.password, (actor) =>
    pages.ctx.runEffects(() => setRole(pages.ctx.deps, actor, { userId: params.data.id, role: parsed.data.role })),
  );
  return changed.isErr() ? refused(pages, req, reply, changed.error) : reply.redirect(USERS_PATH, SEE_OTHER);
};

const capPage = (pages: UserPages) => async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = SignInCapFormSchema.safeParse(req.body);
  if (!parsed.success) return showUsers(pages, req, reply, INVALID_FORM_STATUS, firstIssue(parsed.error));
  const { password, ...input } = parsed.data;
  const saved = await attemptAs(pages, req, password, (actor) =>
    pages.ctx.runEffects(() => setSignInCap(pages.ctx.deps, actor, input)),
  );
  return saved.isErr() ? refused(pages, req, reply, saved.error) : reply.redirect(USERS_PATH, SEE_OTHER);
};

/**
 * `/ui/access/users` (ADR-033 §2, §5): user management. Browser HTML behind the session cookie, the hook's CSRF check
 * AND an admin: a member's request to any of these routes — page or form post — is answered as if the route did not
 * exist. Never an `/api` route or an MCP tool, and a bearer token is never accepted on `/ui`. Thin: parse the form,
 * throttle the step-up password, run the `controllers/users.ts` flow, render a page or redirect. An invite's code and
 * link are rendered once, by the response to the POST that issued them.
 */
export const registerUserRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const pages: UserPages = { ctx, passwords: createAttemptLimiter() };
  const formRoute = { bodyLimit: FORM_BODY_LIMIT_BYTES };

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.addHook('preHandler', requireSession);
    scope.addHook('preHandler', requireAdmin);
    scope.get(USERS_PATH, listPage(pages));
    scope.post(USERS_PATH, formRoute, invitePage(pages));
    scope.post(USER_REISSUE_PATH, formRoute, reissuePage(pages));
    scope.post(USER_DISABLE_PATH, formRoute, disablePage(pages));
    scope.post(USER_ENABLE_PATH, formRoute, enablePage(pages));
    scope.post(USER_ROLE_PATH, formRoute, rolePage(pages));
    scope.post(USERS_CAP_PATH, formRoute, capPage(pages));
  });
};
