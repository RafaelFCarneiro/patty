import { z } from 'zod';

/**
 * The domain operation a caller should use instead of the one that was rejected. A domain error carries the operation's
 * name — never an edge's word for it (a tool, a route, a command): each edge translates a remedy into its own
 * vocabulary (`diplomat/mcp/remedy.ts`, `diplomat/http/remedy.ts`).
 */
export const Remedy = z.enum([
  'pay_bill',
  'revert_bill_payment',
  'create_credit_card',
  'update_credit_card',
  'delete_credit_card',
  'update_account_transaction',
  'update_card_transaction',
  'delete_account_transaction',
  'delete_card_transaction',
]);
export type Remedy = z.infer<typeof Remedy>;
