import { READ_METHODS } from './scope.js';

/** The browser surface's root path — redirects are validated against it and `diplomat/http` mounts on it. */
export const UI_ROOT_PATH = '/ui';

export const isUiPath = (path: string): boolean => path === UI_ROOT_PATH || path.startsWith(`${UI_ROOT_PATH}/`);

export const SAFE_METHODS: ReadonlySet<string> = new Set([...READ_METHODS, 'OPTIONS']);
export const OPAQUE_ORIGIN = 'null';
export const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Where a login or setup lands when the caller named no (valid) destination. */
export const DEFAULT_LANDING_PATH = UI_ROOT_PATH;

/** The connect page: a one-segment path under `/ui`, reached from a link the stdio process prints. */
export const CONNECT_PATH = `${UI_ROOT_PATH}/connect`;
export const CONNECT_CODE_PARAM = 'code';

/** Everything the same-origin (CSRF) decision reads from a request. */
export type CsrfRequest = {
  method: string;
  publicUrl: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
};
