/**
 * Loopback-only bind host for the HTTP surface (sidecar and pure http mode). Deliberately
 * NOT '::' or '0.0.0.0': this API is unauthenticated (ADR-013 assumes local-first, no auth),
 * and binding the wildcard address makes it reachable from any device on the same LAN, not
 * just this machine — verified empirically, not just in theory.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/** The scheme every origin this server prints or compares for itself starts with (it serves plain HTTP). */
export const HTTP_SCHEME_PREFIX = 'http://';

/** Bind addresses meaning "every interface" — not a URL anyone can open. */
export const IPV4_WILDCARD_HOST = '0.0.0.0';
export const IPV6_WILDCARD_HOST = '::';
const WILDCARD_HOSTS: ReadonlySet<string> = new Set([IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST]);

/** Browsers key cookies by host, not port — a second loopback name is how a temporary app gets cookies of its own. */
export const LOCALHOST_NAME = 'localhost';
const IPV6_LOOPBACK_HOST = '::1';
const IPV4_LOOPBACK_BLOCK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_IPV4_OCTET = 255;

const stripBrackets = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/**
 * True for a host that only this machine can reach: `localhost`, `::1`, or anything in 127.0.0.0/8.
 * A wildcard bind is deliberately NOT loopback — it listens on every interface. Used both to derive
 * the auth default from `HOST` and to refuse an unauthenticated non-loopback bind (ADR-033 §1).
 */
export const isLoopbackHost = (host: string): boolean => {
  const normalized = stripBrackets(host.trim().toLowerCase());
  if (normalized === LOCALHOST_NAME || normalized === IPV6_LOOPBACK_HOST) return true;
  const octets = IPV4_LOOPBACK_BLOCK.exec(normalized)?.slice(1).map(Number);
  return octets !== undefined && octets.every((octet) => octet <= MAX_IPV4_OCTET);
};

/**
 * Origin (`http://host:port`) a user can actually open for a server bound to `host`. A wildcard
 * bind is reachable through the machine's own loopback (e.g. a container's host-side port
 * publish), so it prints `LOOPBACK_HOST`; any other host prints itself (IPv6 literals bracketed).
 */
export const httpOrigin = (host: string, port: number): string => {
  const reachableHost = WILDCARD_HOSTS.has(host) ? LOOPBACK_HOST : host;
  return `${HTTP_SCHEME_PREFIX}${reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost}:${port}`;
};

/** Where a running instance's dashboards start. */
export const DASHBOARD_PATH = '/ui/overview';

export const isPortInUse = (e: unknown): e is { code: string; port: number; address?: string } =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === 'EADDRINUSE' &&
  typeof (e as { port?: unknown }).port === 'number';

/** Fatal (pure http) EADDRINUSE message: the retry command plus the URL the client should use. The
 *  error's own bind `address` names the host actually bound; absent, the default loopback applies. */
export const portInUseMessage = ({ port, address }: { port: number; address?: string }): string =>
  `fintrack: ${portInUseReason(port)}.\n` +
  `Set a different port and retry, e.g. PORT=${port + 1} fintrack\n` +
  `Then point your MCP client at ${httpOrigin(address ?? LOOPBACK_HOST, port + 1)}/mcp`;

/** Shared wording for both the fatal (pure http) and non-fatal (sidecar) EADDRINUSE messages. */
export const portInUseReason = (port: number): string =>
  `port ${port} is already in use (another service or MCP server is on it)`;

/** The hostname of a `Host` request header (port stripped, IPv6 unbracketed), or `null` if it is not a
 *  well-formed host. A `Host` is an authority — `host[:port]` and nothing else — so userinfo (`x@host`), a path,
 *  query or fragment (`host/x`, which a backslash also introduces) make it malformed rather than being quietly
 *  ignored by the URL parser: a malformed header is never trusted as loopback. */
export const hostnameOfHostHeader = (hostHeader: string): string | null => {
  try {
    const parsed = new URL(`${HTTP_SCHEME_PREFIX}${hostHeader}`);
    const isBareAuthority =
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '';
    return isBareAuthority ? stripBrackets(parsed.hostname) : null;
  } catch {
    return null;
  }
};
