import { ToolName } from '../../../models/tool.js';
import { z } from 'zod';
import { applyDueRecurring, createRecurring, listRecurring } from '../../../controllers/recurring.js';
import { CreateRecurringSchema } from '../../../wire/in/recurring.js';
import * as recurringAdapters from '../../../adapters/recurring.js';
import { outcomeToDb } from '../../../adapters/transactions.js';
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const createRecurringDescription =
  'Create a recurring transaction rule (salary, rent, subscription). Materialized by apply_due_recurring, ' +
  'each occurrence carrying the rule\'s merchant. `merchant` names it explicitly (e.g. "Netflix"); omit to ' +
  "derive it from `description` — either way it's normalized the same way a transaction's merchant is, " +
  'so recurring spend shows up in merchant_concentration and reinforces classification like any other spend.';

const createRecurringTool = defineTool({
  name: ToolName.enum.create_recurring,
  config: {
    annotations: MUTATING,
    title: 'Create recurring rule',
    description: createRecurringDescription,
    inputSchema: CreateRecurringSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => createRecurring(deps, args).map(recurringAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listRecurringTool = defineTool({
  name: ToolName.enum.list_recurring,
  config: {
    annotations: READ_ONLY,
    title: 'List recurring rules',
    description: 'List all recurring rules with next due dates.',
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await listRecurring(deps));
  },
});

const applyDueRecurringDescription =
  'Materialize transactions for every rule due on/before `through` (default: today). ' +
  'Past/present occurrences are created as effective; future occurrences are created as pending — ' +
  'so passing a future date pre-creates upcoming salary, rent, and subscriptions as pending, ' +
  'feeding projections without extra monthly effort. Idempotent — safe to call any time.';

const applyDueRecurringTool = defineTool({
  name: ToolName.enum.apply_due_recurring,
  config: {
    annotations: MUTATING,
    title: 'Apply due recurring rules',
    description: applyDueRecurringDescription,
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
  handle: async (args, { deps, runEffects }) => {
    const flow = () => applyDueRecurring(deps, args).map(recurringAdapters.outcomeToDb).map(outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

export const recurringTools = [createRecurringTool, listRecurringTool, applyDueRecurringTool];
