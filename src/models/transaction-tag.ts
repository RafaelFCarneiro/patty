/** No `id`/`version` — a link table like `merchant_category`. `transactionId` is the flow's own
 *  `entity.id`: the minted id on a create, the read row's id on an update. On a
 *  duplicate-idempotency-key replay the minted id was never inserted, so the set addresses a row
 *  that doesn't exist and the applier no-ops — a duplicate replay never touches tags, matching the
 *  first-write-wins treatment the rest of the row already gets (ADR-023 step 3). */
export const TRANSACTION_TAG_ENTITY_TAG = 'transactionTag';

export type TransactionTagSet = { transactionId: string; tagIds: string[] };
