import { INVITE_CODE_PARAM } from '../../models/auth/origin.js';

/** Query parameters whose value is a secret a person was handed: an invite code today. */
export const SECRET_QUERY_PARAMS: readonly string[] = [INVITE_CODE_PARAM];

export const REDACTED = '[Redacted]';

const NAME_VALUE_SEPARATOR = '=';

/** The parameter's name as the server's query parser reads it: percent-decoded (`%63ode` is `code`), any case. */
const nameOf = (pair: string): string => {
  const raw = pair.split(NAME_VALUE_SEPARATOR)[0] ?? '';
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
};

const isSecretPair = (pair: string): boolean =>
  pair.includes(NAME_VALUE_SEPARATOR) && SECRET_QUERY_PARAMS.includes(nameOf(pair));

const redactedPair = (pair: string): string =>
  `${pair.slice(0, pair.indexOf(NAME_VALUE_SEPARATOR))}${NAME_VALUE_SEPARATOR}${REDACTED}`;

/**
 * A request URL as it may be written to a log: the values of the secret parameters are replaced — matched by their
 * decoded name, since an encoded name reaches the handler as the same parameter — and everything else is kept.
 */
export const redactSecretQuery = (url: string): string => {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const fragmentStart = url.indexOf('#', queryStart);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  const query = url
    .slice(queryStart + 1, queryEnd)
    .split('&')
    .map((pair) => (isSecretPair(pair) ? redactedPair(pair) : pair))
    .join('&');
  return `${url.slice(0, queryStart + 1)}${query}${url.slice(queryEnd)}`;
};
