import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyDueRecurring, createRecurring, listRecurring } from '../../../controllers/recurring.js';
import { CreateRecurringSchema } from '../../../wire/in/recurring.js';
import * as recurringAdapters from '../../../adapters/recurring.js';
import { outcomeToDb } from '../../../adapters/transactions.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';

export const registerRecurringTools = (server: McpServer, ctx: McpContext): void => {
  const { deps, runEffects } = ctx;

  server.registerTool(
    'create_recurring',
    {
      title: 'Create recurring rule',
      description:
        'Create a recurring transaction rule (salary, rent, subscription). Materialized by apply_due_recurring, ' +
        'each occurrence carrying the rule\'s merchant. `merchant` names it explicitly (e.g. "Netflix"); omit to ' +
        "derive it from `description` — either way it's normalized the same way a transaction's merchant is, " +
        'so recurring spend shows up in merchant_concentration and reinforces classification like any other spend.',
      inputSchema: CreateRecurringSchema.shape,
    },
    async (args) => {
      const flow = () => createRecurring(deps, args).map(recurringAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'list_recurring',
    { title: 'List recurring rules', description: 'List all recurring rules with next due dates.', inputSchema: {} },
    async () => json(await listRecurring(deps)),
  );

  server.registerTool(
    'apply_due_recurring',
    {
      title: 'Apply due recurring rules',
      description:
        'Materialize transactions for every rule due on/before `through` (default: today). ' +
        'Past/present occurrences are created as effective; future occurrences are created as pending — ' +
        'so passing a future date pre-creates upcoming salary, rent, and subscriptions as pending, ' +
        'feeding projections without extra monthly effort. Idempotent — safe to call any time.',
      inputSchema: {
        through: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'YYYY-MM-DD horizon (default: today). Pass a future date to pre-create upcoming occurrences as pending.',
          ),
      },
    },
    async (args) => {
      const flow = () => applyDueRecurring(deps, args).map(recurringAdapters.outcomeToDb).map(outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
