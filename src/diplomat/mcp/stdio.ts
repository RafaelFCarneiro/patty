import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps, RunEffects, RunEffectsSequence, SignInInterpreter } from '../../controllers/deps.js';
import { AuthMode } from '../../models/auth/mode.js';
import { ownerGate } from './gate.js';
import type { PrincipalGate } from './gate.js';
import { buildMcpServer } from './server.js';
import { createStdioSession, type StdioSession } from './stdioSession.js';

/** Who the stdio channel acts as: the owner under an explicit `FINTRACK_AUTH=disabled`, otherwise whoever signs in
 *  (ADR-034) — with the sign-in capability injected, as the CLI's `Shell.signIn` is. */
export type StdioAuth =
  | { mode: typeof AuthMode.enum.disabled }
  | {
      mode: typeof AuthMode.enum.required;
      profile: string;
      /** `FINTRACK_TOKEN`, when the process has one. */
      envToken: string | undefined;
      signIn: (profile: string) => SignInInterpreter;
    };

/** The connected server, and the sign-in session behind its gate (none for the owner). */
export type StdioConnection = { server: McpServer; session: StdioSession | undefined };

/** Thin diplomat: connects the transport-agnostic MCP server to a stdio transport, gated by the channel's identity —
 *  a `StdioSession` that asks the connected client who it is, or the owner. */
export const connectStdio = async (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  auth: StdioAuth,
): Promise<StdioConnection> => {
  // The connected server reports who spawned it (`initialize`'s clientInfo); the session asks only when it needs to.
  const session =
    auth.mode === AuthMode.enum.required
      ? createStdioSession({
          signIn: auth.signIn(auth.profile),
          profile: auth.profile,
          envToken: auth.envToken,
          clientInfo: () => server.server.getClientVersion(),
        })
      : undefined;
  const gate: PrincipalGate = session ? () => session.resolve() : ownerGate;
  const server = buildMcpServer(deps, version, runEffects, runEffectsSequence, resetLocale, { gate });
  await server.connect(new StdioServerTransport());
  return { server, session };
};
