import { z } from 'zod';
import { type ClientInfo, SignInDuration } from '../../models/auth/grant.js';
import { CONNECT_CODE_PARAM, DEFAULT_LANDING_PATH, INVITE_CODE_PARAM, isUiPath } from '../../models/auth/origin.js';
import { UserRole } from '../../models/auth/owner.js';
import { SignInCap } from '../../models/auth/users.js';
import { PASSWORD_MAX_LENGTH, PasswordSchema, UsernameSchema, normalizeUsername } from '../../models/auth/password.js';
import {
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_VERSION_MAX_LENGTH,
  UNKNOWN_CLIENT_NAME,
  UNKNOWN_CLIENT_VERSION,
} from '../../models/auth/sign-in.js';
import { TOKEN_NAME_MAX_LENGTH, TokenAccess, TokenExpiry } from '../../models/auth/token.js';

// Login accepts whatever was typed (an unknown name must fail like a wrong password, not like bad
// input); only the length is bounded so a body cannot be used to make argon2 chew on megabytes.
const LOGIN_FIELD_MAX_LENGTH = 256;
const SETUP_CODE_MAX_LENGTH = 64;
const MAX_NEXT_LENGTH = 2048;
const SAME_ORIGIN_PROBE = 'http://same-origin.invalid';
const UNSAFE_NEXT_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/**
 * Where to send the browser after login/setup: a same-origin path under `/ui`, or the default. Anything
 * else — absolute URLs, protocol-relative `//host`, backslash tricks, control characters, paths that
 * normalize out of `/ui` — falls back, so `next` can never become an open redirect. A tolerant reader:
 * a bad `next` is not an error, it is simply not honored.
 */
export const safeNextPath = (raw: string | undefined): string => {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return DEFAULT_LANDING_PATH;
  if (!raw.startsWith('/') || raw.startsWith('//') || UNSAFE_NEXT_CHARACTERS.test(raw)) return DEFAULT_LANDING_PATH;
  const resolved = new URL(raw, SAME_ORIGIN_PROBE);
  return resolved.origin === SAME_ORIGIN_PROBE && isUiPath(resolved.pathname)
    ? `${resolved.pathname}${resolved.search}`
    : DEFAULT_LANDING_PATH;
};

const NextPathSchema = z.string().optional().catch(undefined).transform(safeNextPath);

export const LoginFormSchema = z.object({
  username: z.string().min(1).max(LOGIN_FIELD_MAX_LENGTH).transform(normalizeUsername),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  next: NextPathSchema,
});
export type LoginForm = z.infer<typeof LoginFormSchema>;

export const SetupFormSchema = z.object({
  code: z.string().min(1).max(SETUP_CODE_MAX_LENGTH),
  username: UsernameSchema,
  password: PasswordSchema,
});
export type SetupForm = z.infer<typeof SetupFormSchema>;

/** The query string of /ui/login and /ui/setup — where to go afterwards. */
export const NextQuerySchema = z.object({ next: NextPathSchema });

/** `POST /ui/access/tokens`: what the token form submits. */
export const CreateTokenFormSchema = z.object({
  name: z.string().trim().min(1, 'Give the token a name.').max(TOKEN_NAME_MAX_LENGTH),
  access: TokenAccess,
  expiry: TokenExpiry,
  password: z.string().min(1, 'Enter your password to create a token.').max(PASSWORD_MAX_LENGTH),
});
export type CreateTokenForm = z.infer<typeof CreateTokenFormSchema>;

// The code a person types or follows: lookups normalize it, so only its length is bounded here.
const USER_CODE_INPUT_MAX_LENGTH = 32;

/** `GET /ui/connect?code=…`. */
export const ConnectQuerySchema = z.object({
  [CONNECT_CODE_PARAM]: z.string().min(1).max(USER_CODE_INPUT_MAX_LENGTH).optional().catch(undefined),
});

export const ConnectDecision = z.enum(['approve', 'deny']);
export type ConnectDecision = z.infer<typeof ConnectDecision>;

/** `POST /ui/connect`: the consent form. */
export const ConnectFormSchema = z.object({
  [CONNECT_CODE_PARAM]: z.string().min(1).max(USER_CODE_INPUT_MAX_LENGTH),
  decision: ConnectDecision,
  access: TokenAccess,
  duration: SignInDuration,
});
export type ConnectForm = z.infer<typeof ConnectFormSchema>;

// `clientInfo` comes from whatever program spawned us and is shown to the approver, so it is cleaned, not trusted:
// control characters become spaces, the length is bounded, and an unusable value falls back rather than failing
// the sign-in. (It is escaped wherever it is rendered.)
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const reported = (maxLength: number, fallback: string) =>
  z
    .string()
    .optional()
    .catch(undefined)
    .transform((raw) => raw?.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, maxLength) || fallback);

const ClientInfoSchema = z.object({
  name: reported(CLIENT_NAME_MAX_LENGTH, UNKNOWN_CLIENT_NAME),
  version: reported(CLIENT_VERSION_MAX_LENGTH, UNKNOWN_CLIENT_VERSION),
});

export const clientInfoOf = (raw: unknown): ClientInfo =>
  ClientInfoSchema.catch({
    name: UNKNOWN_CLIENT_NAME,
    version: UNKNOWN_CLIENT_VERSION,
  }).parse(raw ?? {});

const STEP_UP_PASSWORD = z.string().min(1, 'Enter your password to confirm.').max(PASSWORD_MAX_LENGTH);

/** `POST /ui/access/users`: invite a new user. */
export const InviteUserFormSchema = z.object({ username: UsernameSchema, role: UserRole, password: STEP_UP_PASSWORD });

/** The actions that only re-ask the admin's password: reissue, disable. */
export const StepUpFormSchema = z.object({ password: STEP_UP_PASSWORD });

export const SetRoleFormSchema = z.object({ role: UserRole, password: STEP_UP_PASSWORD });

export const SignInCapFormSchema = z.object({ maxSignInDuration: SignInCap, password: STEP_UP_PASSWORD });

/** `:id` of a user action. */
export const UserParamsSchema = z.object({ id: z.string().min(1).max(LOGIN_FIELD_MAX_LENGTH) });

const INVITE_CODE_INPUT_MAX_LENGTH = 64;

/** `GET /ui/access/invite?code=…` — the code may also be typed. A bad value is simply not prefilled. */
export const InviteQuerySchema = z.object({
  [INVITE_CODE_PARAM]: z.string().max(INVITE_CODE_INPUT_MAX_LENGTH).optional().catch(undefined),
});

/** What the claim page shows back in its code field after a refusal: whatever was typed, if it was text. */
export const ClaimedCodeEchoSchema = z
  .object({ code: z.string().max(INVITE_CODE_INPUT_MAX_LENGTH).catch('') })
  .catch({ code: '' });

/** `POST /ui/access/invite`: the invited person's code and chosen password. */
export const ClaimInviteFormSchema = z.object({
  code: z.string().min(1, 'Enter your invite code.').max(INVITE_CODE_INPUT_MAX_LENGTH),
  password: PasswordSchema,
});
