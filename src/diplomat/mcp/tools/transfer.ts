import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTransfer } from '../../../controllers/account/transfer.js';
import { TransactionSource } from '../../../models/transaction.js';
import { CreateTransferSchema } from '../../../wire/in/accounts.js';
import { outcomeToDb } from '../../../adapters/transactions.js';
import type { McpContext } from '../context.js';
import { fromResult } from '../respond.js';
import { MUTATING } from '../annotations.js';

export const registerTransferTools = (server: McpServer, ctx: McpContext): void => {
  server.registerTool(
    'create_transfer',
    {
      annotations: MUTATING,
      title: 'Transfer between accounts',
      description:
        'Move value between two accounts (e.g. conta corrente → investimentos). Creates a transaction ' +
        "with type 'transfer' (FROM + TO accounts): debits one balance, credits the other, never appears " +
        'in spending summaries, and shows in both account histories (search_transactions). Both accounts ' +
        'must share the same currency (FX not available yet). Idempotent automatically — a repeat call with ' +
        'the same from/to/description/date/amount is deduped; pass discriminator to record a genuinely ' +
        'separate transfer that would otherwise look identical.',
      inputSchema: CreateTransferSchema.shape,
    },
    async (args, extra) => {
      const { deps, runEffects } = ctx.as(extra);
      const flow = () => createTransfer(deps, args, TransactionSource.enum.mcp).map(outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
