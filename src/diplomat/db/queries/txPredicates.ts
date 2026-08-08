import { sql, type SQL } from 'drizzle-orm';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';

const col = (alias: string, name: string): SQL => sql.raw(alias ? `${alias}.${name}` : name);

/** Transaction "what counts" predicates (ADR-028) — the single home for effective/pending/
 *  committed/expense/non-transfer, composed by any transaction-domain query instead of raw SQL.
 *  `alias` qualifies the column for a joined/aliased query; defaults to `'t'`. */
export const txPredicates = {
  effective: (alias = 't'): SQL => sql`${col(alias, 'status')} = ${TransactionStatus.enum.effective}`,
  pending: (alias = 't'): SQL => sql`${col(alias, 'status')} = ${TransactionStatus.enum.pending}`,
  committed: (alias = 't'): SQL =>
    sql`${col(alias, 'status')} IN (${TransactionStatus.enum.effective}, ${TransactionStatus.enum.pending})`,
  expense: (alias = 't'): SQL => sql`${col(alias, 'type')} = ${TransactionType.enum.expense}`,
  nonTransfer: (alias = 't'): SQL => sql`${col(alias, 'type')} != ${TransactionType.enum.transfer}`,
};
