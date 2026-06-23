# Feature Design 007: Account update + delete

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress · **Branch:** `feat/account-update-delete` (suggested) ·
**Date:** 2026-06-21 · Follows the **block-if-in-use** pattern of Feature Design 005; respects **ADR-010**
(credit accounts are card-managed).

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

Accounts can be created and listed but never **updated** or **deleted** — a gap in the account lifecycle (the
same gap categories had before Design 005). `accounts.id` is referenced by five FKs:

- `transactions.from_account_id` / `to_account_id` — transactions and transfers (both legs),
- `recurring_rules.account_id` — a recurring rule tied to the account,
- `credit_cards.payment_account_id` — the account is a card's default payer,
- `credit_cards.account_id` (**NOT NULL**) — the account **is** a card's internal `credit` account.

Two things follow. (1) Per **ADR-010**, `credit` accounts are managed by their card (created/deleted via the
card; `create_account` rejects `type: 'credit'`) — so `delete_account` / `update_account` must **reject credit
accounts** entirely. (2) For non-credit accounts, "associated" is broader than transactions: deleting an account
that a recurring rule or a credit card depends on would dangle those FKs. So this extends the requested
"transactions/transfers" rule to **all associations** — the integrity-correct version of the same idea.

## Decision

1. **Credit accounts are rejected.** `delete_account` and `update_account` on a `type: 'credit'` account return a
   `validation` error pointing to the card flow (mirrors `create_account` rejecting `credit`; ADR-010). Bank
   accounts only.
2. **Delete — block if in use** (Design 005 pattern). A non-credit account is deleted **only when nothing
   references it**: no transaction/transfer (`from_account_id` OR `to_account_id`), no recurring rule
   (`account_id`), and not a card's payer (`payment_account_id`). Otherwise return an `in_use` error with the
   reference counts; delete nothing. *(Extends the stated "transactions/transfers" to recurring + card-payer for
   referential integrity — flagged for confirmation.)*
3. **Update `name` and `initialBalance` — always allowed.** Neither affects existing transactions: `name` is
   display/resolution only (subject to the existing unique-name rule → `duplicate_name`); `initialBalance` just
   shifts the derived balance (balances are `initialBalance + …`). Editable at any time.
4. **Update `type` and `currency` — only if no associations.** Per the requested rule:
   - **`currency`** is the strict one: transactions denormalize the account's currency at write time and
     balances group per currency, so changing it with existing transactions would create mixed-currency history.
     Allowed only if the account has **no transactions/transfers** *and* is **not a card payer** (the card↔payer
     same-currency invariant from Design 003).
   - **`type`** allowed only if no transactions/transfers (per the request). *(Note: `type` is technically safe
     to change any time — nothing stores the account's type on transactions — so we could relax this to
     "always" later; following the requested rule for now. Changing `type` **to** `credit` is never allowed.)*
   A blocked `type`/`currency` change returns a `validation` error naming the field and why.
5. **No dry-run/confirm.** Like Design 005, delete is non-destructive (only ever removes an unreferenced
   account — no data loss, no orphans), so no two-step confirm. Update is non-destructive by construction.
6. **Resolution + uniqueness reuse.** Resolve the target by name via `resolveByName` (the existing account
   resolver); reuse the `duplicate_name` check on rename.

### Update rules at a glance

| Field | Editable when |
|---|---|
| `name` | always (must stay unique) |
| `initialBalance` | always |
| `type` | only if no transactions/transfers; never set to `credit` |
| `currency` | only if no transactions/transfers **and** not a credit-card payer |

## Scope / out of scope

- **In:** `update_account` (name, initialBalance, type, currency with the rules above) + `delete_account`
  (block-if-in-use across transactions/transfers, recurring rules, card-payer); reject `credit` accounts; MCP
  tools + REST routes; reuse `in_use` (extended to `entity: 'account'`) + `duplicate_name` + `validation`; tests.
- **Out:** reassign-on-delete (move transactions to another account first) — a follow-up like the category one;
  soft archive/disable; bulk ops; changing a `credit` account (card-managed, ADR-010); cross-currency
  conversion of existing transactions (currency change requires an empty account, by design). No schema change.

## Options Considered

### Block-if-in-use + field-level update rules — **chosen**
**Pros:** consistent with Design 005 (categories); safe (never rewrites or orphans transactions); matches the
requested rules; lets the always-safe edits (name, initialBalance) through unconditionally. `in_use` already
exists and generalizes.
**Cons:** not one-shot — the user clears/reassigns associations before delete or a type/currency change. The
`in_use` / `validation` errors make the next step obvious.

### Reassign-on-delete / cascade — deferred or rejected
Cascade-deleting an account's transactions is wrong (you don't delete history because an account was removed).
Reassign-to-another-account is a reasonable *future* one-shot, deferred (same as the category follow-up).

### Allow currency change with conversion — rejected (for now)
Would need an FX source and rewriting denormalized transaction currencies — out of scope (FX is still open).

## Consequences

- **New:** `updateAccount` / `deleteAccount` controllers (`safeTry`, `ResultAsync`); repo methods to
  count account references and to update/delete the row; `in_use` extended with `entity: 'account'` and a
  `references: { transactions, recurring, cards }` shape; MCP tools + REST routes; `docs/mcp-tools.md` entries.
- **Reuse:** `resolveByName` for the account; `duplicate_name` on rename; the `in_use` + `validation` error
  codes; the credit-account guard mirrors `create_account`.
- **No schema/migration** — additive behavior over existing FKs and the existing `accounts` columns.
- **Blast radius:** account controller + repo + two edges + docs. No change to transactions, balances,
  classification, or other tools.

---

## Implementation prompt

> Hand this to a coding agent. Source of truth: this design. Work on branch **`feat/account-update-delete`** off
> `main`; `git fetch && git rebase origin/main` first. Read `CLAUDE.md` (esp. the **Definition of Done**),
> `docs/architecture.md`, `docs/code-style.md`, `docs/code-quality.md`. Mirror the existing account surface and
> the Design 005 delete: `src/controllers/accounts.ts`, `src/diplomat/db/repos/accounts.ts`,
> `src/controllers/categories.ts` (`deleteCategory` for the block-if-in-use shape),
> `src/diplomat/db/repos/categories.ts` (`countReferences`), `src/common/errors.ts` (`in_use`, `duplicate_name`,
> `validation`; how `update_transaction` patches partial fields), `src/diplomat/mcp/server.ts`,
> `src/diplomat/http/routes.ts`.

### Steps

1. **Error code:** extend the existing `in_use` variant to allow `entity: 'account'` with
   `references: { transactions: number; recurring: number; cards: number }` (keep the category shape working).
2. **Repo** (`diplomat/db/repos/accounts.ts`): `countReferences(accountId)` → parameterized `COUNT(*)` over
   `transactions` (`from_account_id = id OR to_account_id = id`), `recurring_rules` (`account_id = id`), and
   `credit_cards` (`payment_account_id = id`). A `delete(accountId)` (single row). An `update(accountId, patch)`
   that sets only provided columns (`name`, `initialBalance`, `type`, `currency`).
3. **`deleteAccount(name)`** (`controllers/accounts.ts`): resolve via `resolveByName`; reject if `type === 'credit'`
   (`validation`, point to the card flow); `countReferences`; if any > 0 → `in_use` with counts; else delete.
4. **`updateAccount(name, patch)`**: resolve; reject if `type === 'credit'` (card-managed) and reject `patch.type
   === 'credit'`. Always allow `name` (re-check `duplicate_name`) and `initialBalance`. For `type`: allow only if
   no transactions/transfers. For `currency`: allow only if no transactions/transfers **and** not a card payer
   (`payment_account_id`); else `validation` naming the field + reason. `safeTry`, `ResultAsync`.
5. **Surface:** `update_account` (input `name` + optional `newName`/`initialBalance`/`type`/`currency`) and
   `delete_account` (input `name`) MCP tools (rich descriptions stating the rules) + REST `PATCH` / `DELETE`
   routes. Constants over literals (`AccountType.enum.*`); thin diplomats.

### Tests
- **Integration** (in-process libSQL): (a) delete an account with no associations → succeeds, gone from
  `list_accounts`; (b) delete with a transaction → `in_use` (`references.transactions ≥ 1`), still present;
  (c) delete an account that's a recurring rule's account → `in_use` (`references.recurring ≥ 1`); (d) delete an
  account that's a card's payer → `in_use` (`references.cards ≥ 1`); (e) delete/update a `credit` account →
  `validation` (card-managed); (f) update `name` + `initialBalance` succeeds even with transactions present;
  (g) update `currency`/`type` blocked (`validation`) when transactions exist, allowed when none; (h) currency
  change blocked when the account is a card payer; (i) rename to an existing name → `duplicate_name`;
  (j) unknown name → `unknown_account`.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **Credit accounts are card-managed** — `delete_account`/`update_account` reject them; `type` can't be set to
  `credit` (ADR-010).
- **Never cascade into transactions** — delete only removes an unreferenced account.
- **Block-if-in-use** across transactions/transfers + recurring + card-payer; `in_use` returned otherwise.
- **`name`/`initialBalance` always editable; `type`/`currency` only on an unassociated account** (currency also
  requires not being a card payer).
- **Diplomatic layering:** resolution + orchestration in the controller; parameterized count/update/delete in
  `diplomat/db`; thin diplomats; zod at boundaries; constants over literals.
- **Docs in the same change:** `docs/mcp-tools.md` (`update_account` / `delete_account` + the extended `in_use`).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push; feature-sized (two tools +
  reference checks + the `in_use` extension), so also run the independent verification pass.

### Finish
Conventional Commits (`feat(accounts): update_account + delete_account (block-if-in-use)` + `test:`/`docs:`),
`git push -u origin feat/account-update-delete`, open a PR targeting `main`. Run the Definition of Done; do not
merge; after CI, reply to review threads with the resolving SHA.

## Deferred follow-up

- **Reassign-on-delete / on currency change:** move an account's transactions to another (same-currency)
  account, enabling a one-shot delete or currency change — parallels the category reassign follow-up.
- **Soft archive/disable** an account (hide from new use, preserve history).
