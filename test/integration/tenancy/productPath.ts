import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import type { AppContext } from '../app-builder.js';
import { approveConnect, claimOwner, mintToken, stdioSessionFor, userCodeIn } from '../auth/helpers.js';
import { addUser } from '../auth/userHelpers.js';
import { mintTokenFor, seedWorld, WORLD_A, worldOf, type Actor, type Outcome } from './world.js';

/** What the two-user fixtures hand a test: the actors, and whatever must be closed afterwards. */
export type Seeded = { a: Actor; b: Actor; close?: () => Promise<void> };

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A tool call over the MCP stdio gate, as Claude makes it: the client talks to a server whose every request asks the
 *  stdio session who is signed in. */
const stdioCaller = async (ctx: AppContext, cookie: string) => {
  const { session } = stdioSessionFor(ctx);
  await approveConnect(ctx, cookie, userCodeIn(await session.resolve()), { access: 'write', duration: '24h' });
  const signedIn = await session.resolve();
  if (signedIn.kind !== 'granted') throw new Error(`stdio sign-in did not complete: ${JSON.stringify(signedIn)}`);

  const mcp = buildMcpServer(ctx.runtime, ctx.version, { gate: () => session.resolve() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'isolation-test', version: '1' });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);

  const call = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = textOf(result);
      return { failed: result.isError === true, status: 200, payload: parseJson(text), text };
    } catch (cause) {
      // A protocol-level refusal (an unknown tool, arguments the schema rejects) is a failure, not a crash.
      const text = cause instanceof McpError ? cause.message : String(cause);
      return { failed: true, status: 200, payload: parseJson(text), text };
    }
  };
  const close = async () => {
    await session.close();
    await client.close();
    await mcp.close();
  };
  return { call, close };
};

/**
 * The same two users as `seedTwoUsers`, but B is created the way a real second user is: the owner (A) claims the
 * instance, an admin invites B, B claims the invite and chooses a password, and B's Claude signs in through the browser
 * (`/ui/connect`). B's tool calls therefore run over a STDIO sign-in; B's REST calls and resource reads use a token B
 * created at `/ui/access/tokens`. Nothing about B is inserted into the database by the test.
 */
export const seedProductPath = async (ctx: AppContext): Promise<Seeded> => {
  const ownerCookie = await claimOwner(ctx);
  const worldB = worldOf('B', '');
  const bob = await addUser(ctx, ownerCookie, worldB.username);
  const world = { ...worldB, userId: bob.userId };

  await seedWorld(ctx.db, WORLD_A);
  await seedWorld(ctx.db, world);

  const stdio = await stdioCaller(ctx, bob.cookie);
  return {
    a: { world: WORLD_A, token: await mintTokenFor(ctx, WORLD_A) },
    b: { world, token: (await mintToken(ctx, bob.cookie)).token, call: stdio.call },
    close: stdio.close,
  };
};
