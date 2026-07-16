import { sql, type SQL } from 'drizzle-orm';

/**
 * What counts as "correlated" to a credit card: a purchase on the card itself (`credit_card_id`)
 * or any movement on its own internal liability account (`from_account_id`/`to_account_id`) —
 * including the bill-payment transfer. `alias` matches whichever table alias (or none) the calling
 * query uses — column names alone aren't ambiguous here, but callers consistently qualify them
 * (mirrors `transactionSelect.ts`'s own `t.`-qualified convention). Shared by
 * `creditCardsRepo.countCorrelated` and `transactionsRepo.findAllCorrelatedToCard` (the latter
 * feeding `deleteCreditCard`'s own domain-decided cascade) — the definition of "correlated" lives
 * in one place.
 */
export const correlatedToCard = (cardId: string, accountId: string, alias = ''): SQL => {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`${col('credit_card_id')} = ${cardId} OR ${col('from_account_id')} = ${accountId} OR ${col('to_account_id')} = ${accountId}`;
};
