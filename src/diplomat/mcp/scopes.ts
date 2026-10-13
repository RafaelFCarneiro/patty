import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { formatAppError } from '../../common/errors.js';
import { hasScope, scopeOfTool } from '../../logic/auth.js';
import { authErrors, READ_SCOPE, type Scope } from '../../models/auth.js';
import { GateKind, type GateOutcome, type PrincipalGate } from './gate.js';
import { jsonError, textError } from './respond.js';

/**
 * Scope enforcement for MCP tools, resources and prompts (ADR-033 §3, ADR-034 §4). Every tool declares
 * `annotations.readOnlyHint`; its scope is derived from that one hint (`logic/auth.ts`'s `scopeOfTool`) and recorded
 * here, so there is a single source for both the HTTP edge's pre-check (`route.ts`) and the in-handler check below.
 * Resources and prompts only read, so they need `fintrack:read`.
 *
 * `guardScopes` wraps `server.registerTool`, `registerResource` and `registerPrompt`:
 *   - registering a tool without a boolean `readOnlyHint` throws — an undeclared tool cannot exist;
 *   - every callback first asks the transport's `PrincipalGate` who is calling: a refusal is a tool error result
 *     (a structured one for HTTP, the plain sign-in instructions for a signed-out stdio session) or, for a resource
 *     or prompt, a JSON-RPC error — and the callback never runs.
 * `initialize` and the list requests (tools, resources, prompts) are not wrapped: the client can always see what
 * the server offers.
 */
export type ScopeGuardOptions = { gate: PrincipalGate };

const toolScopesByServer = new WeakMap<McpServer, Map<string, Scope>>();

/** The scope each registered tool needs, by tool name. */
export const toolScopesOf = (server: McpServer): ReadonlyMap<string, Scope> =>
  toolScopesByServer.get(server) ?? new Map();

type Callback = (...args: unknown[]) => unknown;

type Refusal = Exclude<GateOutcome, { kind: typeof GateKind.enum.granted }>;

/** `null` = proceed; otherwise what to answer instead of running the callback. */
const refusalOf = (outcome: GateOutcome, required: Scope): Refusal | null => {
  if (outcome.kind !== GateKind.enum.granted) return outcome;
  return hasScope(outcome.principal.scopes, required)
    ? null
    : { kind: GateKind.enum.refused, error: authErrors.insufficientScope(required) };
};

const refusalText = (refusal: Refusal): string =>
  refusal.kind === GateKind.enum.not_signed_in ? refusal.message : formatAppError(refusal.error);

/** The request context is always the callback's last argument (`(args, extra)`, `(uri, extra)`, or `(extra)`). */
const gated =
  (callback: Callback, required: Scope, options: ScopeGuardOptions, refuse: (refusal: Refusal) => unknown): Callback =>
  async (...args) => {
    const refusal = refusalOf(await options.gate(args.at(-1)), required);
    return refusal === null ? callback(...args) : refuse(refusal);
  };

const toolRefusal = (refusal: Refusal) =>
  refusal.kind === GateKind.enum.refused ? jsonError(refusal.error) : textError(refusal.message);

const throwRefusal = (refusal: Refusal): never => {
  throw new McpError(ErrorCode.InvalidRequest, refusalText(refusal));
};

const withGatedLastArgument =
  (register: (...args: unknown[]) => unknown, wrap: (callback: Callback) => Callback) =>
  (...args: unknown[]) =>
    register(...args.slice(0, -1), wrap(args.at(-1) as Callback));

export const guardScopes = (server: McpServer, options: ScopeGuardOptions): void => {
  const scopes = new Map<string, Scope>();
  toolScopesByServer.set(server, scopes);

  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    callback: Callback,
  ) => unknown;
  server.registerTool = ((name, config, callback) => {
    const readOnlyHint = config.annotations?.readOnlyHint;
    if (typeof readOnlyHint !== 'boolean') {
      throw new Error(`fintrack: MCP tool "${name}" must declare annotations.readOnlyHint (its scope derives from it)`);
    }
    const required = scopeOfTool(readOnlyHint);
    scopes.set(name, required);
    return registerTool(name, config, gated(callback as Callback, required, options, toolRefusal));
  }) as McpServer['registerTool'];

  const readOnly = (callback: Callback) => gated(callback, READ_SCOPE, options, throwRefusal);
  server.registerResource = withGatedLastArgument(
    server.registerResource.bind(server) as unknown as (...args: unknown[]) => unknown,
    readOnly,
  ) as McpServer['registerResource'];
  server.registerPrompt = withGatedLastArgument(
    server.registerPrompt.bind(server) as unknown as (...args: unknown[]) => unknown,
    readOnly,
  ) as McpServer['registerPrompt'];
};
