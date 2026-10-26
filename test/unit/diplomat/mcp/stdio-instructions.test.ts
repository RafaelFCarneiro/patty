import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { Tenancy } from '../../../../src/controllers/deps.js';
import { DEMO_SERVER_INSTRUCTIONS } from '../../../../src/diplomat/mcp/instructions.js';
import { connectStdio } from '../../../../src/diplomat/mcp/stdio.js';
import { AuthMode } from '../../../../src/models/auth/mode.js';
import { InstanceKind } from '../../../../src/models/instance.js';
import { Locale } from '../../../../src/models/locale.js';

const mocks = vi.hoisted(() => ({ serverSide: undefined as unknown }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return mocks.serverSide as object;
    }
  },
}));

const instructionsOver = async (kind: InstanceKind, locale: Locale = Locale.enum.en): Promise<string | undefined> => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mocks.serverSide = serverSide;
  const tenancy = { instanceKind: async () => kind, instanceLocale: async () => locale } as unknown as Tenancy;
  const client = new Client({ name: 'stdio-instructions-test', version: '1' });
  const [{ server }] = await Promise.all([
    connectStdio(tenancy, '0.0.0', { mode: AuthMode.enum.disabled }),
    client.connect(clientSide),
  ]);
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return instructions;
};

describe('connectStdio — server instructions', () => {
  it.each(Object.values(Locale.enum))('sends the demo instructions in the demo’s language (%s)', async (locale) => {
    expect(await instructionsOver(InstanceKind.enum.demo, locale)).toBe(DEMO_SERVER_INSTRUCTIONS[locale]);
  });

  it('sends none for a standard database', async () => {
    expect(await instructionsOver(InstanceKind.enum.standard)).toBeUndefined();
  });
});
