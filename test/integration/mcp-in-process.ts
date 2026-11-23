import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { buildMcpServer } from '../../src/diplomat/mcp/server.js';

const TEST_CLIENT_VERSION = '9.9.9';

/** Connects a client to an MCP server over an in-process transport pair instead of a pipe or a socket. */
export const connectInProcess = async (
  mcp: ReturnType<typeof buildMcpServer>,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: TEST_CLIENT_VERSION });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await mcp.close();
    },
  };
};
