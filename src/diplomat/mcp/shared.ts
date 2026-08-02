/** Shared by import_card_statement/import_account_statement — the per-item
 *  classification/idempotency/result-status contract is identical for both single-source importers. */
export const STATEMENT_IMPORT_RESULT_DESCRIPTION =
  'Each item is auto-classified and idempotent (key derived from date+description+amount when absent — ' +
  're-importing is safe). Returns a per-item status: created, needs_review (low confidence — confirm ' +
  'categories with the user), duplicate, or error.';
