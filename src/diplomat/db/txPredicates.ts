import { sql, type SQL } from 'drizzle-orm';
import { TransactionStatus, TransactionType } from '../../models/transaction.js';

const col = (alias: string, name: string): SQL => sql.raw(alias ? `${alias}.${name}` : name);

/**
 * The transaction "what counts" predicates (ADR-028) — the single home for effective/pending/
 * committed/expense/non-transfer, so a transaction-domain query composes one of these instead of
 * re-authoring `t.status = 'effective'`/`t.type != 'transfer'` as raw SQL per repo. `alias` lets a
 * caller qualify the column for a joined/aliased query (mirrors `correlatedToCard`,
 * `diplomat/db/repos/transactions.ts`); defaults to `'t'`, the alias every current consumer uses
 * for its own transactions table reference.
 */
export const txPredicates = {
  effective: (alias = 't'): SQL => sql`${col(alias, 'status')} = ${TransactionStatus.enum.effective}`,
  pending: (alias = 't'): SQL => sql`${col(alias, 'status')} = ${TransactionStatus.enum.pending}`,
  committed: (alias = 't'): SQL =>
    sql`${col(alias, 'status')} IN (${TransactionStatus.enum.effective}, ${TransactionStatus.enum.pending})`,
  expense: (alias = 't'): SQL => sql`${col(alias, 'type')} = ${TransactionType.enum.expense}`,
  nonTransfer: (alias = 't'): SQL => sql`${col(alias, 'type')} != ${TransactionType.enum.transfer}`,
};
