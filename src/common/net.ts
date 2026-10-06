/**
 * Loopback-only bind host for the HTTP surface (sidecar and pure http mode). Deliberately
 * NOT '::' or '0.0.0.0': this API is unauthenticated (ADR-013 assumes local-first, no auth),
 * and binding the wildcard address makes it reachable from any device on the same LAN, not
 * just this machine — verified empirically, not just in theory.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/** Bind addresses meaning "every interface" — not a URL anyone can open. */
export const IPV4_WILDCARD_HOST = '0.0.0.0';
export const IPV6_WILDCARD_HOST = '::';
const WILDCARD_HOSTS: ReadonlySet<string> = new Set([IPV4_WILDCARD_HOST, IPV6_WILDCARD_HOST]);

/**
 * Origin (`http://host:port`) a user can actually open for a server bound to `host`. A wildcard
 * bind is reachable through the machine's own loopback (e.g. a container's host-side port
 * publish), so it prints `LOOPBACK_HOST`; any other host prints itself (IPv6 literals bracketed).
 */
export const httpOrigin = (host: string, port: number): string => {
  const reachableHost = WILDCARD_HOSTS.has(host) ? LOOPBACK_HOST : host;
  return `http://${reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost}:${port}`;
};

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
