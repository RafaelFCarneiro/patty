import { sql, type SQL } from 'drizzle-orm';

/** What counts as "correlated" to a credit card: a purchase on the card itself (`credit_card_id`)
 *  or any movement on its own internal liability account (`from_account_id`/`to_account_id`),
 *  including the bill-payment transfer. `alias` lets a caller qualify the columns for a joined
 *  query. Shared by `creditCardsRepo.countCorrelated` and `transactionsRepo.findAllCorrelatedToCard`
 *  so the definition lives in one place. */
export const correlatedToCard = (cardId: string, accountId: string, alias = ''): SQL => {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`${col('credit_card_id')} = ${cardId} OR ${col('from_account_id')} = ${accountId} OR ${col('to_account_id')} = ${accountId}`;
};
