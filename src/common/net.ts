export const isPortInUse = (e: unknown): e is { code: string; port: number } =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === 'EADDRINUSE' &&
  typeof (e as { port?: unknown }).port === 'number';

/** Shared wording for both the fatal (pure http) and non-fatal (sidecar) EADDRINUSE messages. */
export const portInUseReason = (port: number): string =>
  `port ${port} is already in use (another service or MCP server is on it)`;
