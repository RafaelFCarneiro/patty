# Feature Design 017: Recurring rules carry a merchant

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Done · **Date:** 2026-07-25 · Extends the recurring domain. Prerequisite for
**Feature Design 016** Phase B (exact recurring-candidate exclusion). Reuses the merchant-key normalization + the
`withMerchant` merchant-emission pattern (`logic/merchant.ts`).

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`. **One PR**:
> `feat/recurring-merchant`.

## Context

A recurring rule *is* a merchant relationship — rent to a landlord, Netflix, a gym. But `recurring_rules` has no
`merchant_key` (schema: `description, amount, type, period, next_due, currency, account_id, category_id,
version`), and `apply_due_recurring` materializes occurrences with **no merchant** on them. Two consequences:

1. **Recurring spend is invisible to merchant analytics and learning** — it never appears in merchant
   concentration (Design 016 C), and it can't reinforce `merchant_category`.
2. **Recurring-candidate detection (Design 016 B) can only exclude loosely** — with no `merchant_key` on a rule,
   "is this merchant already a rule?" is an approximate match on category+amount, so a genuine
   already-automated merchant can slip back into the suggestions.

Both dissolve if a rule carries the merchant it pays.

## Decision

Add `merchant_key` to `recurring_rules` and thread it onto materialized occurrences.

1. **Schema (migration):** `recurring_rules.merchant_key TEXT` → FK `merchants.key`, **nullable** (existing rules
   have no known merchant; see backfill).
2. **`create_recurring` sets the merchant** — optional explicit `merchant` (stored as given, normalized), else
   the merchant is resolved the same way a transaction's is: `deps.merchants.matchCandidates` + `pickClassification`
   first, reusing an already-learned `merchant_category` key so the rule reinforces the same merchant identity a
   matching transaction would, falling back to `normalizeMerchant(description)` (`logic/merchant.ts`,
   empty-string guarded — an empty key can't back a `merchants` FK — then leave `null`) only when nothing
   matches. (Caught in review: an earlier revision always used the full normalized description for the derived
   case, which could fragment merchant identity — e.g. `"netflix com"` instead of a seeded/learned `"netflix"`.)
   The flow emits the `MERCHANT_ENTITY_TAG` `Persistable` alongside the rule (via `withMerchant`) so the
   `merchants` row exists before the FK is written — same batch (rule 5).
3. **`apply_due_recurring` threads it** — each materialized occurrence carries the rule's `merchant_key`, so
   recurring transactions now appear in merchant concentration and are matchable. The merchant row already
   exists (created with the rule), so the occurrence just references it; no extra merchant emission needed at
   materialization.
4. **Backfill: existing rules stay `null`.** `normalizeMerchant` is TS (accent-stripping, noise prefixes) and
   can't be faithfully reproduced in a SQL migration, so existing rows are left `null` rather than
   mis-derived. They gain a merchant when re-saved. *(There is no `update_recurring` today — noted; a future one
   would let existing rules acquire a merchant without delete+recreate. Track as an issue if it bites.)*

## Options / decisions

- **Merchant source: explicit-or-derived (chosen)** — matches how transactions get a merchant key; the user can
  name it, or it falls out of the description. Alternative "explicit-only" rejected (most rules would go without,
  defeating the point).
- **Nullable column + no backfill (chosen)** vs a best-effort SQL-side derive on migration — rejected: a
  faithful normalize can't run in SQL, and a wrong key is worse than a null.
- **Occurrence carries the rule's merchant (chosen)** — the whole point; makes recurring spend first-class in
  merchant analytics.

## Docs to update

- `docs/architecture.md` — `recurring_rules.merchant_key` in the schema; the data-convention note that recurring
  occurrences carry a merchant.
- `docs/write-path.md` — `createRecurring` now emits a merchant `Persistable` (its per-flow note).
- `docs/mcp-tools.md` — `create_recurring`'s `merchant` param.
- Feature Design 016 — Phase B exclusion becomes exact (cross-referenced).

## Testing

- `create_recurring` with explicit `merchant` → stored + merchant row emitted; without → derived from
  `description`; description that normalizes to empty → `merchant_key` null, no FK violation.
- `apply_due_recurring` → materialized occurrence carries the rule's `merchant_key`; it shows up in a merchant
  concentration query; idempotent re-run unaffected.
- Existing (pre-migration) rule → `merchant_key` null, still materializes fine.

## Implementation prompt

One PR, behind the full gate. Read `docs/write-path.md` (the recurring flow notes, `withMerchant`) and
`docs/architecture.md` § Write path guardrails first.

Migration (`recurring_rules.merchant_key` nullable FK); `models/recurring.ts` (`merchant` on
`CreateRecurringSchema`, `merchantKey` on the entity); `adapters/recurring.ts`; `controllers/recurring.ts`
(`createRecurring` resolves/derives the merchant, emits `withMerchant`; `applyDueRecurring` threads
`merchant_key` onto each occurrence); `create_recurring` tool's `merchant` param; docs. Feature-sized (schema +
two flows) → independent verification subagent on the diff.

### Finish (every push)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing.
