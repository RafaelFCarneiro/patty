import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SERVER_INSTRUCTIONS } from '../../../src/diplomat/mcp/instructions.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';
import { instanceFactsOf } from '../../../src/controllers/instance.js';
import { registerHttpApp } from '../../../src/composition/http.js';
import { buildApp, type AppContext } from '../app-builder.js';

const dirs: string[] = [];
const apps: AppContext[] = [];

const appOf = async (kind: InstanceKind, opts: Parameters<typeof buildApp>[0] = {}, locale?: Locale) => {
  const dir = mkdtempSync(join(tmpdir(), 'patty-demo-mcp-'));
  dirs.push(dir);
  const ctx = await buildApp({ dbPath: join(dir, 'test.db'), ...opts });
  apps.push(ctx);
  await ctx.app.ready();
  await ctx.db.run(sql`UPDATE settings SET instance_kind = ${kind} WHERE id = 'singleton'`);
  if (locale) {
    await ctx.db.run(
      sql`INSERT INTO user_settings (user_id, locale, locale_source) VALUES ('user-owner', ${locale}, 'explicit')`,
    );
  }
  return ctx;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((ctx) => ctx.app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const instructionsOverMemory = async (ctx: AppContext): Promise<string | undefined> => {
  const server = buildMcpServer(ctx.runtime, ctx.version, { gate: ownerGate }, await instanceFactsOf(ctx.runtime));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'demo-instructions-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return instructions;
};

describe('MCP server instructions', () => {
  it('a demo database sends the demo instructions at initialize, in English by default', async () => {
    expect(await instructionsOverMemory(await appOf(InstanceKind.enum.demo))).toBe(DEMO_SERVER_INSTRUCTIONS.en);
  });

  it.each(Object.values(Locale.enum))('a demo database speaks the owner’s language (%s)', async (locale) => {
    const ctx = await appOf(InstanceKind.enum.demo, {}, locale);
    expect(await instructionsOverMemory(ctx)).toBe(DEMO_SERVER_INSTRUCTIONS[locale]);
  });

  it('a standard database sends none', async () => {
    expect(await instructionsOverMemory(await appOf(InstanceKind.enum.standard))).toBeUndefined();
  });
});

describe('MCP server instructions over streamable HTTP /mcp', () => {
  // A real listener and client: the SDK's HTTP transport needs a real socket, which `inject` does not provide.
  const instructionsOverHttp = async (ctx: AppContext): Promise<string | undefined> => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    const client = new Client({ name: 'demo-instructions-http-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const instructions = client.getInstructions();
    await client.close();
    return instructions;
  };

  it('is sent for a demo database, in the owner’s language', async () => {
    const ctx = await appOf(InstanceKind.enum.demo, {}, Locale.enum.pt);
    expect(await instructionsOverHttp(ctx)).toBe(DEMO_SERVER_INSTRUCTIONS.pt);
  });

  it('is omitted for a standard database', async () => {
    expect(await instructionsOverHttp(await appOf(InstanceKind.enum.standard))).toBeUndefined();
  });
});

describe('get_status over MCP', () => {
  const statusOver = async (ctx: AppContext): Promise<{ demo: boolean }> => {
    const server = buildMcpServer(ctx.runtime, ctx.version, { gate: ownerGate });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'demo-status-test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const result = await client.callTool({ name: 'get_status', arguments: {} });
    await client.close();
    await server.close();
    const [text] = result.content as Array<{ text: string }>;
    return JSON.parse(text?.text ?? '{}') as { demo: boolean };
  };

  it('reports demo: true on a demo database and false otherwise', async () => {
    expect((await statusOver(await appOf(InstanceKind.enum.demo))).demo).toBe(true);
    expect((await statusOver(await appOf(InstanceKind.enum.standard))).demo).toBe(false);
  });
});

describe('/mcp with an unreadable marker', () => {
  const post = async (method: string, params?: Record<string, unknown>): Promise<Response> => {
    const ctx = await appOf(InstanceKind.enum.demo);
    const failing = {
      ...ctx.runtime,
      instanceKind: async (): Promise<InstanceKind> => {
        throw new Error('marker unreadable');
      },
    };
    const app = Fastify();
    registerHttpApp(app, failing, ctx.version, ctx.auth);
    apps.push({ ...ctx, app });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  };

  it('still answers a ping: only initialize reads the marker', async () => {
    const res = await post('ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: {} });
  });

  it('refuses initialize rather than connect a client without the demo warning', async () => {
    const res = await post('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.status).toBe(500);
  });
});
