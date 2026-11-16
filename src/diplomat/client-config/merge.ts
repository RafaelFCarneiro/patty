import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../models/auth/sign-in.js';
import { DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT } from '../../models/demo/core.js';
import { PACKAGE_SPEC } from '../../models/package.js';
import { ServersKey } from '../../wire/out/client-config.js';

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

/** The key under which a client's entry carries its environment variables. */
export const ENV_KEY = {
  env: 'env',
  environment: 'environment',
} as const;
export type EnvKey = (typeof ENV_KEY)[keyof typeof ENV_KEY];

export const VSCODE_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

/** A client config entry that signs in as `profile`: `PATTY_PROFILE` is added to its environment (under `envKey`)
 *  only when the profile is not the default, so an ordinary install writes exactly the entry it always did
 *  (ADR-034 §5.2). */
export const withProfile = <E extends Record<string, unknown>>(
  entry: E,
  profile: string,
  envKey: EnvKey = ENV_KEY.env,
): E | (E & Record<EnvKey, Record<string, string>>) =>
  profile === DEFAULT_PROFILE ? entry : { ...entry, [envKey]: { [PROFILE_ENV_VAR]: profile } };

export const withDemo = <E extends Record<string, unknown>>(
  entry: E,
  databasePath: string,
  envKey: EnvKey = ENV_KEY.env,
): E & Record<EnvKey, Record<string, string>> =>
  ({
    ...entry,
    [envKey]: { DB_PATH: databasePath, PORT: String(DEMO_PORT), [DEMO_ENV_VAR]: DEMO_ENV_ON },
  }) as E & Record<EnvKey, Record<string, string>>;

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
