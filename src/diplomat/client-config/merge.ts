import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../models/auth/sign-in.js';
import { PACKAGE_SPEC } from '../../models/package.js';

// ---------------------------------------------------------------------------
// Shared MCP entry shapes
// ---------------------------------------------------------------------------

export const resolveConfigObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const STDIO_ENTRY = {
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

export const VSCODE_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

/** A client config entry that signs in as `profile`: `FINTRACK_PROFILE` is added to its `env` only when the profile
 *  is not the default, so an ordinary install writes exactly the entry it always did (ADR-034 §5.2). */
export const withProfile = <E extends Record<string, unknown>>(
  entry: E,
  profile: string,
): E | (E & { env: Record<string, string> }) =>
  profile === DEFAULT_PROFILE ? entry : { ...entry, env: { [PROFILE_ENV_VAR]: profile } };

// ---------------------------------------------------------------------------
// Pure config merge helpers (testable without FS)
// ---------------------------------------------------------------------------

/** Merges `{ mcpServers: { fintrack: entry } }` into an existing config object. */
export const mergeMcpServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const servers = resolveConfigObject(existing['mcpServers']) ?? {};
  return { ...existing, mcpServers: { ...servers, fintrack: entry } };
};

/** Merges `{ servers: { fintrack: entry } }` into an existing config object (VS Code shape). */
export const mergeServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const servers = resolveConfigObject(existing['servers']) ?? {};
  return { ...existing, servers: { ...servers, fintrack: entry } };
};
