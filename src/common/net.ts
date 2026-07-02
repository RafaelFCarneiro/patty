export const isPortInUse = (e: unknown): e is { code: string; port: number } =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === 'EADDRINUSE' &&
  typeof (e as { port?: unknown }).port === 'number';
