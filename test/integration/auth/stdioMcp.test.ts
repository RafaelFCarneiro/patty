import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { createStdioSession } from '../../../src/diplomat/mcp/stdioSession.js';
import { createSignInInterpreter } from '../../../src/composition/signIn/interpreter.js';
import { authDepsOf, answerConnect, claimOwner, memoryStore, useAuthApp, SIGN_IN_ORIGIN } from './helpers.js';
import type { AppContext } from '../app-builder.js';

const createApp = useAuthApp();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

/** What `main.ts` wires for a stdio run, over an in-process transport pair instead of a pipe. */
const connectStdioClient = async (ctx: AppContext, options: { owner?: boolean; envToken?: string } = {}) => {
  const store = memoryStore();
  const session = createStdioSession({
    signIn: createSignInInterpreter({
      deps: authDepsOf(ctx),
      run: bindAuthRunEffects(ctx.authRunEffects),
      store,
      origin: () => SIGN_IN_ORIGIN,
    }),
    profile: 'default',
    envToken: options.envToken,
    clientInfo: () => mcp?.server.getClientVersion(),
  });
  const mcp = buildMcpServer(ctx.runtime, ctx.version, {
    gate: options.owner ? ownerGate : () => session.resolve(),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '9.9.9' });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(async () => {
    await session.close();
    await client.close();
    await mcp.close();
  });
  return { client, session, store };
};

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

describe('MCP over stdio — signed out', () => {
  it('lets the client connect and list tools, resources and prompts without signing in', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);

    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    expect((await client.listResources()).resources.length).toBeGreaterThan(0);
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
  });

  it('answers a tool call with an ordinary error result carrying the link and the code', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);

    const result = await client.callTool({ name: 'list_accounts', arguments: {} });

    expect(result.isError).toBe(true);
    const code = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(textOf(result))?.[1];
    expect(textOf(result)).toBe(
      `FinTrack: not signed in. Open ${SIGN_IN_ORIGIN}/ui/connect?code=${code} and confirm the code ${code}.`,
    );
  });

  it('shows the same pending request on the next call, and tells the approver which client asked', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);

    const first = textOf(await client.callTool({ name: 'list_accounts', arguments: {} }));
    const second = textOf(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(second).toBe(first);

    const code = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(first)![1]!;
    const page = await ctx.app.inject({
      method: 'GET',
      url: `/ui/connect?code=${code}`,
      headers: { host: '127.0.0.1:51737', cookie },
    });
    expect(page.body).toContain('test-client');
    expect(page.body).toContain('9.9.9');
  });

  it('gates every tool the same way, reads and writes alike', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);
    const calls = [
      { name: 'get_status', arguments: {} },
      { name: 'list_categories', arguments: {} },
      { name: 'create_tag', arguments: { name: 'travel' } },
      { name: 'set_locale', arguments: { locale: 'en', source: 'explicit' } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(textOf(result), call.name).toContain('not signed in');
    }
    expect(await ctx.db.all(sql`SELECT 1 FROM tags`)).toEqual([]);
  });

  it('refuses to read a resource, with the instructions in the error', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);

    const failure = await client.readResource({ uri: 'fintrack://accounts' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpError);
    expect((failure as McpError).message).toContain('FinTrack: not signed in. Open ');
  });

  it('refuses to get a prompt, with the instructions in the error', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);

    const failure = await client.getPrompt({ name: 'monthly_review', arguments: {} }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpError);
    expect((failure as McpError).message).toContain('not signed in');
  });
});

describe('MCP over stdio — after approval', () => {
  it('runs the very next call: signed out, then approved in the browser, then it works', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);
    const asked = textOf(await client.callTool({ name: 'list_accounts', arguments: {} }));
    const code = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(asked)![1]!;

    expect(
      (await answerConnect(ctx, cookie, code, { decision: 'approve', access: 'write', duration: '24h' })).statusCode,
    ).toBe(200);

    const ok = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(textOf(ok))).toEqual([]);
    expect((await client.callTool({ name: 'create_tag', arguments: { name: 'travel' } })).isError).toBeFalsy();
  });

  it('serves resources and prompts too once signed in', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);
    const asked = textOf(await client.callTool({ name: 'get_status', arguments: {} }));
    await answerConnect(ctx, cookie, /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(asked)![1]!, { decision: 'approve' });

    expect((await client.readResource({ uri: 'fintrack://accounts' })).contents).toHaveLength(1);
    expect((await client.getPrompt({ name: 'monthly_review', arguments: {} })).messages.length).toBeGreaterThan(0);
  });

  it('refuses a write tool to a read-only sign-in with insufficient_scope — and runs the read tools', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);
    const asked = textOf(await client.callTool({ name: 'get_status', arguments: {} }));
    await answerConnect(ctx, cookie, /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(asked)![1]!, {
      decision: 'approve',
      access: 'read',
    });

    const refused = await client.callTool({ name: 'create_tag', arguments: { name: 'nope' } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('insufficient_scope');
    expect(textOf(refused)).toContain('fintrack:write');
    expect((await client.callTool({ name: 'list_tags', arguments: {} })).isError).toBeFalsy();
    expect((await client.readResource({ uri: 'fintrack://tags' })).contents).toHaveLength(1);
  });

  it('asks again on the next call after the sign-in is revoked', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { client } = await connectStdioClient(ctx);
    const asked = textOf(await client.callTool({ name: 'get_status', arguments: {} }));
    await answerConnect(ctx, cookie, /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(asked)![1]!, { decision: 'approve' });
    expect((await client.callTool({ name: 'get_status', arguments: {} })).isError).toBeFalsy();

    await ctx.db.run(sql`UPDATE access_tokens SET revoked_at = ${new Date().toISOString()}`);

    const again = await client.callTool({ name: 'get_status', arguments: {} });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('not signed in');
  });
});

describe('MCP over stdio — FINTRACK_AUTH=disabled', () => {
  it('acts as the owner, ungated, with no sign-in at all', async () => {
    const ctx = await createApp();
    const { client } = await connectStdioClient(ctx, { owner: true });

    expect((await client.callTool({ name: 'create_tag', arguments: { name: 'dev' } })).isError).toBeFalsy();
    expect((await client.readResource({ uri: 'fintrack://tags' })).contents).toHaveLength(1);
    expect((await client.getPrompt({ name: 'monthly_review', arguments: {} })).messages.length).toBeGreaterThan(0);
  });
});
