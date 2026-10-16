import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Scoped } from '../../../../src/controllers/deps.js';
import { MUTATING, READ_ONLY } from '../../../../src/diplomat/mcp/annotations.js';
import { authInfoOf } from '../../../../src/diplomat/mcp/authInfo.js';
import type { McpContext } from '../../../../src/diplomat/mcp/context.js';
import { definePrompt, defineTool } from '../../../../src/diplomat/mcp/definition.js';
import { ownerGate } from '../../../../src/diplomat/mcp/gate.js';
import { promptDefinitions } from '../../../../src/diplomat/mcp/prompts.js';
import { registerDefinitions } from '../../../../src/diplomat/mcp/register.js';
import { resourceDefinitions } from '../../../../src/diplomat/mcp/resources.js';
import { guardScopes, toolScopesOf } from '../../../../src/diplomat/mcp/scopes.js';
import { toolDefinitions } from '../../../../src/diplomat/mcp/tools/index.js';
import { OWNER_PRINCIPAL } from '../../../../src/models/auth/principal.js';
import { PromptName } from '../../../../src/models/prompts.js';
import { ToolName } from '../../../../src/diplomat/mcp/toolName.js';

const sorted = (names: readonly string[]) => [...names].sort();

describe('the definition lists', () => {
  it('define every tool name exactly once — a name without a definition (or the reverse) cannot ship', () => {
    expect(sorted(toolDefinitions.map(({ name }) => name))).toEqual(sorted(ToolName.options));
  });

  it('define every prompt name exactly once', () => {
    expect(sorted(promptDefinitions.map(({ name }) => name))).toEqual(sorted(PromptName.options));
  });

  it('give every tool a title and a description the agent can read', () => {
    toolDefinitions.forEach(({ name, config }) => {
      expect(config.title.length, name).toBeGreaterThan(0);
      expect(config.description.length, name).toBeGreaterThan(0);
    });
  });

  it('give every resource a unique uri', () => {
    const uris = resourceDefinitions({}).map(({ uri }) => uri);
    expect(new Set(uris).size).toBe(uris.length);
  });
});

describe('registerDefinitions', () => {
  const scoped = { deps: { marker: 'deps' } } as unknown as Scoped;
  const ctx: McpContext = { version: '1.2.3', as: () => scoped };
  const extra = { authInfo: authInfoOf(OWNER_PRINCIPAL) };

  // The SDK keeps what was registered in private maps; reading them is how the scope-guard tests drive a callback too.
  type Callback = (...args: unknown[]) => Promise<unknown>;
  type Registry = {
    _registeredTools: Record<string, { handler: Callback }>;
    _registeredPrompts: Record<string, { callback: Callback }>;
    _registeredResources: Record<string, { readCallback: Callback }>;
  };
  const registry = (server: McpServer) => server as unknown as Registry;

  const guardedServer = () => {
    const server = new McpServer({ name: 'test', version: '0' });
    guardScopes(server, { gate: ownerGate });
    return server;
  };

  it('registers a tool through the scope guard with the scoped dependencies and the context', async () => {
    const handle = vi.fn(async () => ({ content: [] }));
    const tool = defineTool({
      name: ToolName.enum.get_status,
      config: { title: 't', description: 'd', inputSchema: { n: z.number() }, annotations: READ_ONLY },
      handle,
    });
    const server = guardedServer();
    registerDefinitions(server, ctx, { prompts: [], resources: [], tools: [tool] });

    await registry(server)._registeredTools.get_status!.handler({ n: 4 }, extra);

    expect(handle).toHaveBeenCalledWith({ n: 4 }, scoped, ctx);
    expect(Object.fromEntries(toolScopesOf(server))).toEqual({ get_status: 'fintrack:read' });
  });

  it('takes a tool’s scope from its declared annotation', () => {
    const writer = defineTool({
      name: ToolName.enum.create_tag,
      config: { title: 't', description: 'd', inputSchema: {}, annotations: MUTATING },
      handle: async () => ({ content: [] }),
    });
    const server = guardedServer();
    registerDefinitions(server, ctx, { prompts: [], resources: [], tools: [writer] });
    expect(toolScopesOf(server).get('create_tag')).toBe('fintrack:write');
  });

  it('registers a prompt and a resource the same way', async () => {
    const handle = vi.fn(async () => ({ messages: [] }));
    const prompt = definePrompt({
      name: PromptName.enum.import_statement,
      config: { title: 't', description: 'd', argsSchema: {} },
      handle,
    });
    const read = vi.fn(async () => ({ contents: [] }));
    const resource = {
      name: 'r',
      uri: 'fintrack://r',
      config: { title: 't', description: 'd', mimeType: 'x/y' },
      read,
    };
    const server = guardedServer();
    registerDefinitions(server, ctx, { prompts: [prompt], resources: [resource], tools: [] });

    await registry(server)._registeredPrompts.import_statement!.callback({}, extra);
    await registry(server)._registeredResources['fintrack://r']!.readCallback(new URL('fintrack://r'), extra);

    expect(handle).toHaveBeenCalledWith({}, scoped, ctx);
    expect(read).toHaveBeenCalledWith(new URL('fintrack://r'), scoped, ctx);
  });
});
