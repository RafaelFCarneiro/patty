import {
  MCP_TOOLS_CALL_METHOD,
  READ_METHODS,
  READ_SCOPE,
  type Scope,
  WRITE_SCOPE,
  type JsonRpcMessage,
} from '../../models/auth/scope.js';

export const hasScope = (granted: readonly string[], required: Scope): boolean =>
  granted.includes(required) || (required === READ_SCOPE && granted.includes(WRITE_SCOPE));

export const defaultScopeForMethod = (method: string): Scope =>
  READ_METHODS.includes(method.toUpperCase()) ? READ_SCOPE : WRITE_SCOPE;

export const scopeOfTool = (readOnlyHint: boolean | undefined): Scope =>
  readOnlyHint === true ? READ_SCOPE : WRITE_SCOPE;

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
