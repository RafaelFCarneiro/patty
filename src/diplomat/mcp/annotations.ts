/**
 * The MCP tool annotations every `registerTool` call declares (ADR-033 §3). `readOnlyHint` is the single
 * source of a tool's scope — `logic/auth.ts`'s `scopeOfTool`: read-only → `fintrack:read`, anything else →
 * `fintrack:write` — and clients use the same hint to decide how freely to run a tool. A tool that changes
 * anything (including a read-then-write like `apply_due_recurring`) is `MUTATING`.
 */
export const READ_ONLY = { readOnlyHint: true } as const;
export const MUTATING = { readOnlyHint: false } as const;
