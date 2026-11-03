import type { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape, ZodTypeAny } from 'zod';
import type { Scoped } from '../../controllers/deps.js';
import type { PromptName } from '../../models/prompts.js';
import type { ToolName } from './tool-name.js';
import type { MUTATING, READ_ONLY } from './annotations.js';
import type { McpContext } from './context.js';

/**
 * What every MCP tool, resource and prompt is: one named definition — declarative metadata plus a handler that adapts
 * its arguments, delegates and translates (docs/code-quality.md § One named definition per tool / route). The handler
 * is handed the caller's already-scoped dependencies; the generic registrar (`register.ts`) resolves them from the
 * principal the scope guard put on the callback, so no handler touches `extra`.
 */
type Args<Shape extends ZodRawShape> = z.objectOutputType<Shape, ZodTypeAny>;

export type ToolDefinition<Shape extends ZodRawShape = ZodRawShape> = {
  name: ToolName;
  config: {
    title: string;
    description: string;
    inputSchema: Shape;
    /** `READ_ONLY` or `MUTATING` — the single source of the tool's scope (ADR-033 §3). */
    annotations: typeof READ_ONLY | typeof MUTATING;
  };
  handle: (args: Args<Shape>, scoped: Scoped, ctx: McpContext) => Promise<CallToolResult>;
};

export type ResourceDefinition = {
  name: string;
  uri: string;
  config: { title: string; description: string; mimeType: string };
  read: (uri: URL, scoped: Scoped, ctx: McpContext) => Promise<ReadResourceResult>;
};

export type PromptDefinition<Shape extends ZodRawShape = ZodRawShape> = {
  name: PromptName;
  /** Omit `argsSchema` for a prompt that takes no arguments: the client then needs no `arguments` object at all. */
  config: { title: string; description: string; argsSchema?: Shape };
  handle: (args: Args<Shape>, scoped: Scoped, ctx: McpContext) => Promise<GetPromptResult>;
};

/** Infers the argument types from `config`; the returned definition is the shape-erased one a list holds. */
export const defineTool = <Shape extends ZodRawShape>(definition: ToolDefinition<Shape>): ToolDefinition =>
  definition as unknown as ToolDefinition;

export const definePrompt = <Shape extends ZodRawShape>(definition: PromptDefinition<Shape>): PromptDefinition =>
  definition as unknown as PromptDefinition;
