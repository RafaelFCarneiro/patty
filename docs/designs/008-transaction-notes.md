# Feature Design 008: Transaction notes (observações)

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress · **Branch:** `feat/transaction-notes` (suggested) ·
**Date:** 2026-06-21 · Additive transaction field.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

Real-world usage surfaced a missing field: a free-form **note** (observação) on a transaction — "split with
João", "reimbursable", "warranty until 2027", "annual subscription, cancel next year". It's distinct from the
fields we already have:

- **`description`** — *what* the transaction is ("Almoço restaurante"); drives classification + FTS.
- **`tags`** — short, reusable labels for filtering ("work", "travel").
- **`rawInput`** — the original natural-language phrasing captured for audit (MCP-created).
- **`note`** (new) — a deliberate, free-form human memo the user attaches; not for classification or filtering.

So this is a new nullable free-text column on `transactions`, threaded through create/update/read. Purely
additive — no behavior changes elsewhere.

## Decision

1. **New nullable column `note`** on `transactions` (`text`, nullable). One free-form memo per transaction.
   Capped at a sane length (e.g. 1000 chars) via zod at the boundary.
2. **Settable on create, editable + clearable on update.** `create_transaction` (and bulk items) accept an
   optional `note`. `update_transaction` patches it: a provided value sets it; an **empty string clears it**
   (stored as `null`); omitting it leaves it untouched — consistent with the existing partial-patch convention.
3. **Returned in `TransactionView`.** `note` rides along in every transaction read (`search_transactions`,
   `get_bill` rows, create/update results) so the user sees their observations. `fullTxSelect` already does
   `SELECT t.*`, so the column is present in the row — just add `note` to the row schema + the view.
4. **Not classified, not filtered, not FTS-indexed (v1).** `note` is inert: classification ignores it (only
   `description` → merchant key), and it is **not** added to the FTS index. Free-text *search by note* is a
   clean follow-up (extend the `transactions_fts` table + triggers), deferred to keep v1 a simple additive field.
5. **Distinct from `rawInput`.** `note` is user-authored intent; `rawInput` is captured original phrasing. Keep
   both; don't conflate.

## Scope / out of scope

- **In:** `note` column + migration; `note` on `create_transaction` / `create_transactions_bulk` /
  `update_transaction` (set/clear); `note` in `TransactionView` (all read tools); wire/adapter threading;
  `docs/mcp-tools.md`; tests.
- **Out:** **search-by-note (FTS)** — deferred follow-up (FTS table/trigger change); a note on recurring rules
  that propagates to materialized transactions — deferred; multiple notes / threaded comments (it's a single
  memo); localization (free user text, not chrome).

## Options Considered

### Single nullable `note` column on the transaction — **chosen**
**Pros:** trivial, additive; matches how `rawInput`/`description` already live on the row; one migration, no new
table; `SELECT t.*` already surfaces it.
**Cons:** not searchable until FTS is extended (acceptable for v1; deferred).

### Reuse `tags` for notes — rejected
Tags are short, reusable, filterable labels with their own table and dedup semantics; a free-form sentence isn't
a tag. Wrong shape.

### Separate `transaction_notes` table (1‑to‑many) — rejected (for now)
Threaded/multiple notes is more than the need (one memo per transaction). A column is the right weight; a side
table can come later if multi-note is ever wanted.

## Consequences

- **Schema/migration:** `ALTER TABLE transactions ADD note text` (nullable). No backfill (existing rows → null).
- **Model/wire/adapters:** `note?` on `Transaction`, `TransactionView`, `CreateTransactionInput`,
  `TransactionPatch`, `UpdateTransactionInput`, and `BulkTransactionItem`; `note` in `TransactionRowSchema`
  (`wire/db`) + `TransactionDbProps`; `modelToDb`/`dbToModel`/`patchToDb` map it.
- **Surface:** `note` added to `create_transaction`, `create_transactions_bulk` (per item), and
  `update_transaction` input schemas (MCP + REST), and present in every `TransactionView` output.
- **Blast radius:** additive across the transaction stack; no change to classification, balances, summaries, or
  other entities.

---

## Implementation prompt

> Hand this to a coding agent. Source of truth: this design. Work on branch **`feat/transaction-notes`** off
> `main`; `git fetch && git rebase origin/main` first. **Follow the project guidelines — mandatory:** read
> `CLAUDE.md` (esp. the **Definition of Done**), `docs/architecture.md`, `docs/diplomatic-architecture.md`,
> `docs/code-style.md`, `docs/code-quality.md`, and conform (diplomatic layering, zod-decode at boundaries,
> constants over literals, single responsibility). Mirror how `rawInput` is threaded through the transaction
> stack — `note` follows the exact same path. Skim `src/diplomat/db/schema.ts`,
> `src/diplomat/db/transactionSelect.ts`, `src/models/transaction.ts`, `src/adapters/transactions.ts`,
> `src/wire/{in,out,db}/transactions.ts`, `src/controllers/transactions.ts`, `src/diplomat/mcp/server.ts`,
> `src/diplomat/http/routes.ts`.

### Steps

1. **Schema + migration:** add `note text` (nullable) to `transactions` in `schema.ts`; generate the migration
   (`npx drizzle-kit generate`). No FTS change.
2. **Model:** add `note?: string` (zod `.string().max(1000).optional()`) to `Transaction`, `TransactionView`,
   `CreateTransactionInput`, `TransactionPatch`, `UpdateTransactionInput`; `BulkTransactionItem` inherits it.
3. **Wire/adapters:** add `note` to `TransactionRowSchema` (nullable) + `TransactionDbProps`; map it in
   `modelToDb` (`note: entity.note ?? null`), `dbToModel` (`note: row.note ?? undefined`), and `patchToDb`
   (set when provided; empty string → `null` to clear).
4. **Controllers:** `createTransaction`/bulk pass `note` through to the draft; `updateTransaction` includes
   `note` in the patch (set/clear/untouched per convention). No new logic.
5. **Surface:** add `note` to the `create_transaction`, `create_transactions_bulk` (item), and
   `update_transaction` MCP input schemas (with a `.describe()` clarifying it's a free-form memo, distinct from
   `description`) + REST; `note` flows out via `TransactionView`. Update `docs/mcp-tools.md`.
6. Do **not** add `note` to classification or the FTS index (deferred).

### Tests
- **Integration** (in-process libSQL): create a transaction with a `note` → it round-trips in
  `search_transactions`; `update_transaction` sets a note on a note-less transaction; `update_transaction` with
  an empty string clears it (→ absent/null); omitting `note` on update leaves it untouched; a note is returned
  on `get_bill` transaction rows.
- **Unit:** the zod max-length bound rejects an over-long note.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **`note` is inert:** classification uses only `description`; balances/summaries unaffected; not FTS-indexed.
- **Partial-patch convention:** omitted = untouched, empty string = clear, value = set — matches existing
  `update_transaction` field handling.
- **Distinct from `rawInput`/`description`/`tags`** — don't conflate or repurpose.
- **Diplomatic layering:** model→db threading in adapters; controllers orchestrate; thin diplomats; zod at
  boundaries; constants over literals.
- **Docs in the same change:** `docs/mcp-tools.md` (`note` on create/bulk/update + in the transaction view).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push; this touches the schema (a
  migration) and the transaction stack, so also run the independent verification pass.

### Finish
Conventional Commits (`feat(transactions): free-form note (observação)` + `test:`/`docs:`),
`git push -u origin feat/transaction-notes`, open a PR targeting `main`. Run the Definition of Done; do not
merge; after CI, reply to review threads with the resolving SHA.

## Deferred follow-up

- **Search by note:** add `note` to the `transactions_fts` virtual table + its insert/update/delete triggers, and
  have `search_transactions`' free-text filter match description **or** note.
- **Recurring note:** an optional note on a recurring rule that propagates to each materialized transaction.
