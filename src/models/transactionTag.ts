/** No `id`/`version` — a link table like `merchant_category`. Addressed by `idempotencyKey`, not
 *  `transactionId`: a create flow's own `entity.id` is a fresh mint on every call, so on a
 *  duplicate-idempotency-key resubmission it names a row that was never inserted —
 *  `idempotencyKey` reliably resolves to whichever row actually persisted. */
export const TRANSACTION_TAG_ENTITY_TAG = 'transactionTag';

export type TransactionTagSet = { idempotencyKey: string; tagIds: string[] };
