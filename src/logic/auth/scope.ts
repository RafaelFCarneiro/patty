import {
  MCP_TOOLS_CALL_METHOD,
  READ_METHODS,
  READ_SCOPE,
  Scope,
  WRITE_SCOPE,
  type JsonRpcMessage,
} from '../../models/auth/scope.js';

/** `fintrack:write` implies `fintrack:read`; nothing else implies anything. */
export const hasScope = (granted: readonly string[], required: Scope): boolean =>
  granted.includes(required) || (required === READ_SCOPE && granted.includes(WRITE_SCOPE));

/** The default REST rule: reading methods need `read`, every other method needs `write`. Route definitions
 *  call this explicitly so each one's scope stays visible and reviewable (and a new method fails closed). */
export const defaultScopeForMethod = (method: string): Scope =>
  READ_METHODS.includes(method.toUpperCase()) ? READ_SCOPE : WRITE_SCOPE;

/** An MCP tool's scope comes from its `readOnlyHint` annotation — the single source. Anything not declared
 *  read-only needs `write`. */
export const scopeOfTool = (readOnlyHint: boolean | undefined): Scope =>
  readOnlyHint === true ? READ_SCOPE : WRITE_SCOPE;

/**
 * The scope a POST /mcp body needs: `write` if any message is a `tools/call` of a write tool (or of a tool
 * we cannot place — fail closed), else `read`. Other JSON-RPC methods (initialize, tools/list, resources/*,
 * prompts/*, ping, notifications) execute nothing that writes. Handles a batch (array) as well as one message.
 */
export const requiredMcpScope = (body: unknown, toolScope: (name: string) => Scope | undefined): Scope => {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const needsWrite = messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const { method, params } = message as JsonRpcMessage;
    if (method !== MCP_TOOLS_CALL_METHOD) return false;
    const name = params?.name;
    return typeof name !== 'string' || (toolScope(name) ?? WRITE_SCOPE) === WRITE_SCOPE;
  });
  return needsWrite ? WRITE_SCOPE : READ_SCOPE;
};
