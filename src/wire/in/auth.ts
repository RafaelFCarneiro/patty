import { z } from 'zod';
import {
  DEFAULT_LANDING_PATH,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  PasswordSchema,
  UI_ROOT_PATH,
  UsernameSchema,
} from '../../models/auth.js';

// Login accepts whatever was typed (an unknown name must fail like a wrong password, not like bad
// input); only the length is bounded so a body cannot be used to make argon2 chew on megabytes.
const LOGIN_FIELD_MAX_LENGTH = 256;
const SETUP_CODE_MAX_LENGTH = 64;
const MAX_NEXT_LENGTH = 2048;
const SAME_ORIGIN_PROBE = 'http://same-origin.invalid';
const UNSAFE_NEXT_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

const isUiPath = (path: string): boolean => path === UI_ROOT_PATH || path.startsWith(`${UI_ROOT_PATH}/`);

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
