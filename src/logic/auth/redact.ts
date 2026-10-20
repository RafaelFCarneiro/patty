import { SECRET_QUERY_PARAMS, REDACTED, NAME_VALUE_SEPARATOR } from '../../models/auth/redact.js';

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
