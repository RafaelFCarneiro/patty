import { z } from 'zod';

/** What a credential may do (ADR-033 §3). `fintrack:write` implies `fintrack:read` — see `logic/auth/scope.ts`'s
 *  `hasScope`. The values are the OAuth scope strings clients see in challenges and metadata. */
export const Scope = z.enum(['fintrack:read', 'fintrack:write']);
export type Scope = z.infer<typeof Scope>;
export const ALL_SCOPES: readonly Scope[] = Scope.options;
export const READ_SCOPE = Scope.enum['fintrack:read'];
export const WRITE_SCOPE = Scope.enum['fintrack:write'];

export const READ_METHODS = ['GET', 'HEAD'];

export const MCP_TOOLS_CALL_METHOD = 'tools/call';

/** The one JSON-RPC message shape `requiredMcpScope` looks at. */
export type JsonRpcMessage = { method?: unknown; params?: { name?: unknown } | null };
