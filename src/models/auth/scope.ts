import { z } from 'zod';

/** What a credential may do (ADR-033 §3). `patty:write` implies `patty:read` — see `logic/auth/scope.ts`'s
 *  `hasScope`. The values are the OAuth scope strings clients see in challenges and metadata. */
export const Scope = z.enum(['patty:read', 'patty:write']);
export type Scope = z.infer<typeof Scope>;
export const ALL_SCOPES: readonly Scope[] = Scope.options;
export const READ_SCOPE = Scope.enum['patty:read'];
export const WRITE_SCOPE = Scope.enum['patty:write'];

export const READ_METHODS = ['GET', 'HEAD'];

export const MCP_TOOLS_CALL_METHOD = 'tools/call';

/** The one JSON-RPC message shape `requiredMcpScope` looks at. */
export type JsonRpcMessage = { method?: unknown; params?: { name?: unknown } | null };
