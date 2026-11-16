import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../models/auth/sign-in.js';
import { DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT } from '../../models/demo/core.js';
import { PACKAGE_SPEC } from '../../models/package.js';
import { ServersKey, type EnvKey } from '../../wire/out/client-config.js';

// ---------------------------------------------------------------------------
// Shared MCP entry shapes
// ---------------------------------------------------------------------------

export const resolveConfigObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const STDIO_ENTRY = {
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

/** OpenCode's local server shape: the command is one array, and it is `type: 'local'`. */
export const OPENCODE_ENTRY = {
  type: 'local',
  command: ['npx', '-y', PACKAGE_SPEC],
} as const;

export const VSCODE_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

type WithEnv<E, K extends EnvKey> = E & { [P in K]: Record<string, string> };

/** The entry with `env` under the client's own key — the one place a computed key needs a cast. */
const withEnvironment = <E extends Record<string, unknown>, K extends EnvKey>(
  entry: E,
  envKey: K,
  env: Record<string, string>,
): WithEnv<E, K> => ({ ...entry, [envKey]: env }) as WithEnv<E, K>;

/** A client config entry that signs in as `profile`: `PATTY_PROFILE` is added to its environment (under `envKey`)
 *  only when the profile is not the default, so an ordinary install writes exactly the entry it always did
 *  (ADR-034 §5.2). */
export const withProfile = <E extends Record<string, unknown>, K extends EnvKey>(
  entry: E,
  profile: string,
  envKey: K,
): E | WithEnv<E, K> =>
  profile === DEFAULT_PROFILE ? entry : withEnvironment(entry, envKey, { [PROFILE_ENV_VAR]: profile });

export const withDemo = <E extends Record<string, unknown>, K extends EnvKey>(
  entry: E,
  databasePath: string,
  envKey: K,
): WithEnv<E, K> =>
  withEnvironment(entry, envKey, { DB_PATH: databasePath, PORT: String(DEMO_PORT), [DEMO_ENV_VAR]: DEMO_ENV_ON });

// ---------------------------------------------------------------------------
// Pure config merge helpers (testable without FS)
// ---------------------------------------------------------------------------

export const SERVER_NAME = 'patty';

const mergeServer = (
  key: ServersKey,
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
  name: string,
): Record<string, unknown> => {
  const servers = resolveConfigObject(existing[key]) ?? {};
  return { ...existing, [key]: { ...servers, [name]: entry } };
};

export const mergeMcpServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
  name: string = SERVER_NAME,
): Record<string, unknown> => mergeServer(ServersKey.enum.mcpServers, existing, entry, name);

export const mergeServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
  name: string = SERVER_NAME,
): Record<string, unknown> => mergeServer(ServersKey.enum.servers, existing, entry, name);

export const withoutServer = (
  existing: Record<string, unknown>,
  key: ServersKey,
  name: string,
): Record<string, unknown> | null => {
  const servers = resolveConfigObject(existing[key]);
  if (servers === null || !(name in servers)) return null;
  const { [name]: _removed, ...rest } = servers;
  return { ...existing, [key]: rest };
};
