import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeClient } from './helpers.js';

const messageText = (result: { messages: Array<{ content: { type: string; text?: string } }> }): string => {
  const message = result.messages[0];
  expect(message).toBeDefined();
  expect(message?.content.type).toBe('text');
  const text = message?.content.text;
  expect(typeof text).toBe('string');
  return text!;
};

describe('MCP guided-workflow prompts (Feature Design 019)', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);
  });

  afterAll(async () => {
    await transport.close();
  });

  it('lists all three prompts', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['monthly_review', 'budget_checkup', 'import_statement']),
    );
  });

  it(
    'rejects a getPrompt call that omits the arguments object entirely (all three take an argsSchema, so ' +
      'the MCP SDK requires the object to be present even though every field inside it is optional)',
    async () => {
      await expect(client.getPrompt({ name: 'monthly_review' })).rejects.toThrow();
    },
  );

  describe('monthly_review', () => {
    it('interpolates the given period into a well-formed message', async () => {
      const result = await client.getPrompt({ name: 'monthly_review', arguments: { month: '3', year: '2026' } });
      const text = messageText(result);
      expect(text).toContain('03/2026');
      expect(text).toContain('get_spending_summary');
      expect(text).toContain('get_budget_status');
    });

    it('defaults to the current period when args are omitted', async () => {
      const result = await client.getPrompt({ name: 'monthly_review', arguments: {} });
      const text = messageText(result);
      const now = new Date();
      const expected = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      expect(text).toContain(expected);
    });
  });

  describe('budget_checkup', () => {
    it('interpolates the given period into a well-formed message', async () => {
      const result = await client.getPrompt({ name: 'budget_checkup', arguments: { month: '11', year: '2025' } });
      const text = messageText(result);
      expect(text).toContain('11/2025');
      expect(text).toContain('get_budget_status');
      expect(text).toContain('update_budget');
    });

    it('defaults to the current period when args are omitted', async () => {
      const result = await client.getPrompt({ name: 'budget_checkup', arguments: {} });
      const text = messageText(result);
      const now = new Date();
      const expected = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      expect(text).toContain(expected);
    });
  });

  describe('import_statement', () => {
    it('names import_card_statement when source is card', async () => {
      const result = await client.getPrompt({ name: 'import_statement', arguments: { source: 'card' } });
      expect(messageText(result)).toContain('import_card_statement');
    });

    it('names import_account_statement when source is account', async () => {
      const result = await client.getPrompt({ name: 'import_statement', arguments: { source: 'account' } });
      expect(messageText(result)).toContain('import_account_statement');
    });

    it('asks which kind of statement when source is omitted', async () => {
      const result = await client.getPrompt({ name: 'import_statement', arguments: {} });
      const text = messageText(result);
      expect(text).toContain('import_card_statement');
      expect(text).toContain('import_account_statement');
    });

    it('rejects an invalid source', async () => {
      await expect(client.getPrompt({ name: 'import_statement', arguments: { source: 'crypto' } })).rejects.toThrow();
    });
  });
});
