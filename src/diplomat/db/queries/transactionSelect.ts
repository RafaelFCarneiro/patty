import { sql } from 'drizzle-orm';
import { ownedBy } from './scope.js';

/**
 * Full transaction SELECT with all LEFT JOINs for name resolution and tag aggregation.
 * Shared by transactionsRepo and billsRepo so a joined column added in one place is
 * never missed in the other — both produce rows decoded by adapters/transactions.ts.
 *
 * Always confined to `userId`'s own transactions (ADR-033 §5): the predicate is part of the SELECT, not something a
 * caller adds, so no read of transactions can leave it out. The joined tables (accounts, cards, tags, categories) are
 * reached only through this user's own foreign keys.
 */
export const fullTxSelect = (userId: string, whereClause: ReturnType<typeof sql>) => sql`
  SELECT t.*,
    fa.name AS from_account_name, ta.name AS to_account_name,
    cc.name AS credit_card_name,
    c.name AS category_name, c.names AS category_names,
    sc.name AS subcategory_name, sc.names AS subcategory_names,
    json_group_array(tg.name) FILTER (WHERE tg.name IS NOT NULL) AS tags
  FROM transactions t
  LEFT JOIN accounts fa   ON fa.id  = t.from_account_id
  LEFT JOIN accounts ta   ON ta.id  = t.to_account_id
  LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
  LEFT JOIN categories c  ON c.id   = t.category_id
  LEFT JOIN categories sc ON sc.id  = t.subcategory_id
  LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
  LEFT JOIN tags tg ON tg.id = tt.tag_id
  WHERE ${ownedBy(userId, 't')} AND (${whereClause})
  GROUP BY t.id
`;
