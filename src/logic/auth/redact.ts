import { INVITE_CODE_PARAM } from '../../models/auth/origin.js';

/** Query parameters whose value is a secret a person was handed: an invite code today. */
export const SECRET_QUERY_PARAMS: readonly string[] = [INVITE_CODE_PARAM];

export const REDACTED = '[Redacted]';

const SECRET_QUERY_PATTERN = new RegExp(`([?&](?:${SECRET_QUERY_PARAMS.join('|')})=)[^&#]*`, 'gi');

/** A request URL as it may be written to a log: the secret parameters' values are replaced, everything else is kept. */
export const redactSecretQuery = (url: string): string => url.replace(SECRET_QUERY_PATTERN, `$1${REDACTED}`);
