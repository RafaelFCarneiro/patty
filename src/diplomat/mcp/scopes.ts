import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppError } from '../../common/errors.js';
import { hasScope, scopeOfTool } from '../../logic/auth.js';
import { authErrors, type Scope } from '../../models/auth.js';
import { jsonError } from './respond.js';

/**
 * Scope enforcement for MCP tools (ADR-033 §3). Every tool declares `annotations.readOnlyHint`; its scope is
 * derived from that one hint (`logic/auth.ts`'s `scopeOfTool`) and recorded here, so there is a single source
 * for both the HTTP edge's pre-check (`route.ts`) and the defence-in-depth check below.
 *
 * `guardToolScopes` wraps `server.registerTool`:
 *   - registering a tool without a boolean `readOnlyHint` throws — an undeclared tool cannot exist;
 *   - the tool's callback first checks `extra.authInfo` (the principal the HTTP edge handed to the transport as
 *     `req.auth`) against the tool's scope and answers with an `insufficient_scope` tool error if it falls short.
 * `requireAuthInfo` distinguishes the transports: over HTTP a call with no `authInfo` means the edge failed to
 * attach one, so it is refused (fail closed); stdio is trusted and carries none.
 */
export type ScopeGuardOptions = { requireAuthInfo: boolean };

const toolScopesByServer = new WeakMap<McpServer, Map<string, Scope>>();

/** The scope each registered tool needs, by tool name. */
export const toolScopesOf = (server: McpServer): ReadonlyMap<string, Scope> =>
  toolScopesByServer.get(server) ?? new Map();

type ToolCallback = (...args: unknown[]) => unknown;

type AuthExtra = { authInfo?: { scopes: string[] } } | undefined;

const denial = (extra: AuthExtra, required: Scope, options: ScopeGuardOptions): AppError | null => {
  if (extra?.authInfo === undefined) return options.requireAuthInfo ? authErrors.unauthenticated : null;
  return hasScope(extra.authInfo.scopes, required) ? null : authErrors.insufficientScope(required);
};

export const guardToolScopes = (server: McpServer, options: ScopeGuardOptions): void => {
  const scopes = new Map<string, Scope>();
  toolScopesByServer.set(server, scopes);
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    callback: ToolCallback,
  ) => unknown;

  server.registerTool = ((name, config, callback) => {
    const readOnlyHint = config.annotations?.readOnlyHint;
    if (typeof readOnlyHint !== 'boolean') {
      throw new Error(`fintrack: MCP tool "${name}" must declare annotations.readOnlyHint (its scope derives from it)`);
    }
    const required = scopeOfTool(readOnlyHint);
    scopes.set(name, required);
    // The request context is always the callback's last argument (`(args, extra)`, or `(extra)` for no-input tools).
    return registerTool(name, config, (...args) => {
      const denied = denial(args.at(-1) as AuthExtra, required, options);
      return denied === null ? (callback as ToolCallback)(...args) : jsonError(denied);
    });
  }) as McpServer['registerTool'];
};
