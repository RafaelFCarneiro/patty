/// <reference types="node" />
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

type JsonObject = Record<string, unknown>;
export type ToolCallOptions = { name: string; args?: JsonObject };

export const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp';
export const preferredAccount = process.env.MCP_SMOKE_ACCOUNT;

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Polls an accumulating stderr buffer until it matches `pattern` — used by tests spawning
 *  `main.ts` as a subprocess to await a sidecar startup/failure message written asynchronously.
 *  Resets `pattern.lastIndex` before every test: a `g`/`y`-flagged regex is stateful across
 *  `.test()` calls, and since the buffer only grows, reusing `lastIndex` from a prior (failed)
 *  call could skip past a match that's already in the buffer, causing a false-negative timeout. */
export const waitForStderr = async (getStderr: () => string, pattern: RegExp, timeoutMs = 10_000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    const buffer = getStderr();
    pattern.lastIndex = 0;
    if (pattern.test(buffer)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for stderr to match ${pattern}. Received so far: ${buffer}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

export const makeClient = () => {
  const client = new Client({ name: 'fintrack-vitest-integration', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  return { client, transport };
};

const parseToolPayload = (toolName: string, result: unknown): unknown => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === 'text')?.text;
  ensure(text, `Tool ${toolName} returned no text payload`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Tool ${toolName} returned invalid JSON payload: ${String(error)}`);
  }
};

export const callTool = async (client: Client, { name, args = {} }: ToolCallOptions): Promise<unknown> => {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  );
  const payload = parseToolPayload(name, result);
  const isError = Boolean((result as { isError?: boolean }).isError);
  if (isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(payload)}`);
  return payload;
};

/** Like callTool but returns the error payload instead of throwing — use when asserting on error shape. */
export const callToolError = async (client: Client, { name, args = {} }: ToolCallOptions): Promise<unknown> => {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  );
  const payload = parseToolPayload(name, result);
  const isError = Boolean((result as { isError?: boolean }).isError);
  if (!isError) throw new Error(`Tool ${name} succeeded but an error was expected`);
  return payload;
};

export const deleteTransactions = async (ids: string[]): Promise<void> => {
  if (!ids.length) return;
  const { client, transport } = makeClient();
  try {
    await client.connect(transport);
    for (const id of ids) {
      try {
        await callTool(client, { name: 'delete_transaction', args: { id, confirm: true } });
      } catch {
        // best-effort per transaction
      }
    }
  } catch {
    // best-effort overall
  } finally {
    await transport.close();
  }
};
