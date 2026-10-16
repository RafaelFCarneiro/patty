import { ToolName } from '../toolName.js';
import { confirmTransaction } from '../../../controllers/transaction/core.js';
import { searchTransactions } from '../../../controllers/transaction/read.js';
import { SortDirection } from '../../../models/page.js';
import {
  ConfirmTransactionSchema,
  SearchTransactionsSchema,
  TransactionSortField,
} from '../../../models/transaction.js';
import { outcomeToDb } from '../../../adapters/transactions.js';
import { defineTool } from '../definition.js';
import { fromResult } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const confirmTransactionDescription =
  'Mark a pending transaction as effective (cleared). ' +
  'Pending transactions are excluded from balances and spending summaries; confirming one makes it count. ' +
  'Optionally correct amount/date in the same call — account/card movements only, rejected for a ' +
  'transfer/bill-payment (a plain status-only confirm of one is still fine). The resolved date (the ' +
  'given date, or the existing date if omitted) must not be in the future. ' +
  'If the transaction is already effective, this is a no-op.';

const confirmTransactionTool = defineTool({
  name: ToolName.enum.confirm_transaction,
  config: {
    annotations: MUTATING,
    title: 'Confirm (clear) a pending transaction',
    description: confirmTransactionDescription,
    inputSchema: ConfirmTransactionSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => confirmTransaction(deps, args).map(outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const searchTransactionsDescription =
  'Search transactions by period (month/year or from/to), type (including transfers), ' +
  'category/account name, or free text. With an account filter this is the full account ' +
  'statement (extrato): expenses, income, and transfers in either direction. Returns a page ' +
  '`{ items, nextCursor?, total? }` (ADR-014) — pass the previous `nextCursor` back as `cursor` ' +
  'to keep walking; `nextCursor` is absent on the last page. `sort`/`dir` must stay the same ' +
  'across a walk (they are bound to the cursor); set `includeTotal: true` on the first call ' +
  'only if you need the total count of matching transactions.';

const searchTransactionsTool = defineTool({
  name: ToolName.enum.search_transactions,
  config: {
    annotations: READ_ONLY,
    title: 'Search transactions',
    description: searchTransactionsDescription,
    inputSchema: {
      ...SearchTransactionsSchema.shape,
      limit: SearchTransactionsSchema.shape.limit.optional().default(50),
      sort: SearchTransactionsSchema.shape.sort.optional().default(TransactionSortField.enum.date),
      dir: SearchTransactionsSchema.shape.dir.optional().default(SortDirection.enum.desc),
    },
  },
  handle: async (args, { deps }) => {
    return fromResult(await searchTransactions(deps, args));
  },
});

export const transactionTools = [confirmTransactionTool, searchTransactionsTool];
