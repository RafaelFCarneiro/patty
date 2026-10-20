import { HTTP_SCHEME_PREFIX, hostnameOfHostHeader, isLoopbackHost } from '../../common/net.js';
import { authErrors, type AuthError } from '../../models/auth/errors.js';
import {
  CONNECT_CODE_PARAM,
  CONNECT_PATH,
  OPAQUE_ORIGIN,
  SAFE_METHODS,
  WEB_PROTOCOLS,
  type CsrfRequest,
} from '../../models/auth/origin.js';

export const isUnsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

const parsedUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const originOf = (url: string): string | null => {
  const parsed = parsedUrl(url);
  return parsed === null || parsed.origin === OPAQUE_ORIGIN ? null : parsed.origin;
};

export const declaredOrigin = (origin: string | undefined, referer: string | undefined): string | null =>
  origin !== undefined ? originOf(origin) : referer !== undefined ? originOf(referer) : null;

export const isSameOrigin = (expectedOrigin: string, declared: string | null): boolean =>
  declared !== null && declared === expectedOrigin;

export const allowedOrigins = (publicUrl: string | undefined, hostHeader: string | undefined): string[] => {
  const hostname = hostHeader === undefined ? null : hostnameOfHostHeader(hostHeader);
  const ownLoopbackOrigin =
    hostHeader !== undefined && hostname !== null && isLoopbackHost(hostname)
      ? [`${HTTP_SCHEME_PREFIX}${hostHeader}`]
      : [];
  return [...(publicUrl === undefined ? [] : [publicUrl]), ...ownLoopbackOrigin];
};

export const csrfVerdict = (request: CsrfRequest): AuthError | null => {
  if (!isUnsafeMethod(request.method)) return null;
  const allowed = allowedOrigins(request.publicUrl, request.host);
  if (allowed.length === 0) return authErrors.unknownOrigin;
  const declared = declaredOrigin(request.origin, request.referer);
  return allowed.some((origin) => isSameOrigin(origin, declared)) ? null : authErrors.crossOrigin;
};

export const preSessionCsrfVerdict = (request: CsrfRequest): AuthError | null =>
  request.origin === undefined && request.referer === undefined ? null : csrfVerdict(request);

const isLoopbackOrigin = (origin: string): boolean => {
  const parsed = parsedUrl(origin);
  return (
    parsed !== null &&
    parsed.origin !== OPAQUE_ORIGIN &&
    WEB_PROTOCOLS.has(parsed.protocol) &&
    isLoopbackHost(parsed.hostname)
  );
};

export const isLoopbackRequest = (request: { host: string | undefined; origin: string | undefined }): boolean => {
  const hostname = request.host === undefined ? null : hostnameOfHostHeader(request.host);
  if (hostname === null || !isLoopbackHost(hostname)) return false;
  return request.origin === undefined || isLoopbackOrigin(request.origin);
};

export const signInOrigin = (fields: {
  httpEnabled: boolean;
  publicUrl: string | undefined;
  boundOrigin: string | null;
  host: string;
}): string | null => {
  if (!fields.httpEnabled) return null;
  if (fields.publicUrl !== undefined) return fields.publicUrl;
  return isLoopbackHost(fields.host) ? fields.boundOrigin : null;
};

export const connectUrl = (origin: string, userCode: string): string =>
  `${origin}${CONNECT_PATH}?${CONNECT_CODE_PARAM}=${userCode}`;

export const resourceOrigin = (publicUrl: string | undefined, host: string | undefined): string | null =>
  allowedOrigins(publicUrl, host)[0] ?? null;
