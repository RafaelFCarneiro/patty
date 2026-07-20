/** The transaction↔tag link entity (ADR-023 step 2): the full desired tag-id set for one
 *  transaction, resolved by the core (`logic/tag.ts`) before it ever reaches the shell. No
 *  `id`/`version` — like `merchant_category`, a link table whose applier makes `transaction_tags`
 *  match the given set (a set-replace, not a row `update`).
 *
 *  Addressed by `idempotencyKey`, not `transactionId`: a create flow's own `entity.id` is a fresh
 *  mint on every invocation (`deps.newId()`), so on a duplicate-idempotency-key resubmission it
 *  names a row that was never actually inserted (the transaction insert no-ops) — targeting it
 *  would either FK-violate (non-empty set) or silently touch nothing (empty set). `idempotencyKey`
 *  is stable across every submission and resolves to whichever row actually persisted, the same
 *  mechanical way `transactionApplier`'s own insert conflict-target/`fetchTxByIdempotencyKey`
 *  already resolve identity for that entity (ADR-023 decision 4: "which key identifies the row
 *  that is actually persisted... not a domain judgement") — not a tag-name-style business
 *  resolution, so `transactionTagApplier` doing it stays within "an applier writes exactly one
 *  table" (decision 6's proxy is about writes, not reads). */
export const TRANSACTION_TAG_ENTITY_TAG = 'transactionTag';

export type TransactionTagSet = { idempotencyKey: string; tagIds: string[] };
