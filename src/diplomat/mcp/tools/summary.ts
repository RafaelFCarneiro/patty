import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSpendingSummary } from '../../../controllers/summary.js';
import type { McpContext } from '../context.js';
import { json } from '../respond.js';

export const registerSummaryTools = (server: McpServer, ctx: McpContext): void => {
  const { deps } = ctx;

  server.registerTool(
    'get_spending_summary',
    {
      title: 'Get spending summary',
      description:
        'Income, expenses, balance and per-category totals for a month — ' +
        'grouped per currency (BRL/USD are never mixed).',
      inputSchema: {
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      },
    },
    async (args) => json(await getSpendingSummary(deps, args)),
  );
};
