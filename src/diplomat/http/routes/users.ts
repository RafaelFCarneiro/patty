import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { err, type ResultAsync } from 'neverthrow';
import type { FlowOutcome } from '@rfc0/effect-runner';
import { z } from 'zod';
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
} from '../../../controllers/auth/users.js';
import { inviteLink } from '../../../logic/auth/users.js';
import { resourceOrigin } from '../../../logic/auth/origin.js';
import { authErrors } from '../../../models/auth/errors.js';
import { AUTH_MESSAGES, USER_PAGE_HEADINGS } from '../../../models/auth/message.js';
import { ActorKind, type Actor, type IssuedInvite } from '../../../models/auth/users.js';
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
} from '../auth-paths.js';
import type { AuthRoutesContext } from '../context.js';
import { addFormParser, FORM_BODY_LIMIT_BYTES, page, STEP_UP_REFUSED_STATUS } from '../form-pages.js';
import { createAttemptLimiter, type AttemptLimiter } from '../rate-limiter.js';
import { requireAdmin, requireSession } from '../session.js';
import { renderInvitedPage, renderUsersPage } from '../user-pages.js';

const INVALID_FORM_STATUS = httpStatus(validation([]));

// What each refusal says on this edge. The domain's messages are neutral; the next step is worded here, in the page's
// own vocabulary (a button on a row), never in the domain's.
const REFUSAL_MESSAGE: Readonly<Partial<Record<AppError['code'], string>>> = {
  invalid_credentials: AUTH_MESSAGES.invalidPassword,
  username_taken: AUTH_MESSAGES.usernameTaken,
  cannot_change_self: AUTH_MESSAGES.cannotChangeSelf,
  last_admin: `${AUTH_MESSAGES.lastAdmin} Make another user an administrator first.`,
  user_disabled: `${AUTH_MESSAGES.userDisabled} Use the Enable button on that row.`,
  unknown_user: AUTH_MESSAGES.unknownUser,
  owner_unclaimed: AUTH_MESSAGES.ownerUnclaimed,
  rate_limited: AUTH_MESSAGES.rateLimited,
};

const refusalOf = (error: AppError): { status: number; message: string } => ({
  status: error.code === authErrors.invalidCredentials.code ? STEP_UP_REFUSED_STATUS : httpStatus(error),
  message: REFUSAL_MESSAGE[error.code] ?? AUTH_MESSAGES.tryAgain,
});

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? AUTH_MESSAGES.tryAgain;

const sessionActor = (req: FastifyRequest, password?: string): Actor => ({
  kind: ActorKind.enum.session,
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

type Replier = (req: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply>;

const showInvited =
  (pages: UserPages, heading: string) => async (issued: IssuedInvite, req: FastifyRequest, reply: FastifyReply) => {
    const origin = resourceOrigin(pages.ctx.publicUrl, req.headers.host);
    const link = origin === null ? null : inviteLink(origin, issued.code);
    return page(reply, 200, await renderInvitedPage({ heading, issued, link }));
  };

const redirectToUsers = (_value: unknown, _req: FastifyRequest, reply: FastifyReply) =>
  reply.redirect(USERS_PATH, SEE_OTHER);

type StepUpAction<P, F extends { password: string }, T> = {
  form: z.ZodType<F, z.ZodTypeDef, unknown>;
  /** The flow, given the actor (who typed the password), the path parameters and the form without the password. */
  run: (actor: Actor, params: P, input: Omit<F, 'password'>) => ResultAsync<T, AppError>;
  onSuccess: (value: T, req: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply>;
};

/** The path parameters of a route about one user. */
type UserParams = z.infer<typeof UserParamsSchema>;
type NoParams = Record<string, never>;

const NO_PARAMS: z.ZodType<NoParams, z.ZodTypeDef, unknown> = z
  .object({})
  .strip()
  .transform(() => ({}));

/**
 * One state-changing admin action: decode the path parameters and the form, run the flow as the typed-password actor
 * through the throttled `attemptAs`, then render the success or the refusal on the users page. Every action that
 * changes who can sign in or what they can do goes through here, so none can skip the password.
 */
const stepUpAction =
  <P, F extends { password: string }, T>(
    pages: UserPages,
    params: z.ZodType<P, z.ZodTypeDef, unknown>,
    action: StepUpAction<P, F, T>,
  ): Replier =>
  async (req, reply) => {
    const decodedParams = params.safeParse(req.params);
    const form = action.form.safeParse(req.body);
    if (!decodedParams.success) return showUsers(pages, req, reply, INVALID_FORM_STATUS, AUTH_MESSAGES.tryAgain);
    if (!form.success) return showUsers(pages, req, reply, INVALID_FORM_STATUS, firstIssue(form.error));
    const { password, ...input } = form.data;
    const result = await attemptAs(pages, req, password, (actor) => action.run(actor, decodedParams.data, input));
    return result.isErr() ? refused(pages, req, reply, result.error) : action.onSuccess(result.value, req, reply);
  };

/** An action on the instance (the invite form, the cap), not on one user: it has no path parameters. */
const instanceAction = <F extends { password: string }, T>(pages: UserPages, action: StepUpAction<NoParams, F, T>) =>
  stepUpAction(pages, NO_PARAMS, action);

/** An action on one user, named by the `:id` of the path. */
const userAction = <F extends { password: string }, T>(pages: UserPages, action: StepUpAction<UserParams, F, T>) =>
  stepUpAction(pages, UserParamsSchema, action);

const runIn = <T>(pages: UserPages, flow: () => ResultAsync<FlowOutcome<T>, AppError>) => pages.ctx.runEffects(flow);

const listPage =
  (pages: UserPages): Replier =>
  (req, reply) =>
    showUsers(pages, req, reply);

const userRoutes = (pages: UserPages) => {
  const { deps } = pages.ctx;
  return {
    invite: instanceAction(pages, {
      form: InviteUserFormSchema,
      run: (actor, _params, input) => runIn(pages, () => inviteUser(deps, actor, input)),
      onSuccess: showInvited(pages, USER_PAGE_HEADINGS.inviteCreated),
    }),
    reissue: userAction(pages, {
      form: StepUpFormSchema,
      run: (actor, params) => runIn(pages, () => reissueInvite(deps, actor, params.id)),
      onSuccess: showInvited(pages, USER_PAGE_HEADINGS.newInvite),
    }),
    disable: userAction(pages, {
      form: StepUpFormSchema,
      run: (actor, params) => runIn(pages, () => disableUser(deps, actor, params.id)),
      onSuccess: redirectToUsers,
    }),
    enable: userAction(pages, {
      form: StepUpFormSchema,
      run: (actor, params) => runIn(pages, () => enableUser(deps, actor, params.id)),
      onSuccess: redirectToUsers,
    }),
    role: userAction(pages, {
      form: SetRoleFormSchema,
      run: (actor, params, input) => runIn(pages, () => setRole(deps, actor, { userId: params.id, role: input.role })),
      onSuccess: redirectToUsers,
    }),
    cap: instanceAction(pages, {
      form: SignInCapFormSchema,
      run: (actor, _params, input) => runIn(pages, () => setSignInCap(deps, actor, input)),
      onSuccess: redirectToUsers,
    }),
  };
};

/**
 * `/ui/access/users`: user management. Browser HTML behind the session cookie, the hook's CSRF check
 * AND an admin: a member's request to any of these routes — page or form post — is answered as if the route did not
 * exist. Never an `/api` route or an MCP tool, and a bearer token is never accepted on `/ui`. Thin: parse the form,
 * throttle the step-up password, run the `controllers/auth/users.ts` flow, render a page or redirect. An invite's code
 * and link are rendered once, by the response to the POST that issued them.
 */
export const registerUserRoutes = (app: FastifyInstance, ctx: AuthRoutesContext): void => {
  const pages: UserPages = { ctx, passwords: createAttemptLimiter() };
  const formRoute = { bodyLimit: FORM_BODY_LIMIT_BYTES };

  void app.register(async (scope) => {
    addFormParser(scope);
    scope.addHook('preHandler', requireSession);
    scope.addHook('preHandler', requireAdmin);
    const routes = userRoutes(pages);
    scope.get(USERS_PATH, listPage(pages));
    scope.post(USERS_PATH, formRoute, routes.invite);
    scope.post(USER_REISSUE_PATH, formRoute, routes.reissue);
    scope.post(USER_DISABLE_PATH, formRoute, routes.disable);
    scope.post(USER_ENABLE_PATH, formRoute, routes.enable);
    scope.post(USER_ROLE_PATH, formRoute, routes.role);
    scope.post(USERS_CAP_PATH, formRoute, routes.cap);
  });
};
