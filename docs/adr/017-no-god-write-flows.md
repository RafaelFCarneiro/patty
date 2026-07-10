# ADR-017: No god write flows — bounded-context ownership for every transaction mutation

**Status:** Proposed · **Date:** 2026-07-10 · **Deciders:** Rafael · Extends **ADR-016** (domain/context
boundaries). ADR-016 split the create surface but left `update_transaction`, `delete_transaction`, and
`create_transactions_bulk` as god tools whose ownership decision was pushed one layer down into
composition-root routers. This ADR finishes the job: the boundary applies to **every** write.

## Context

ADR-016 established aggregate ownership over a shared transaction core and replaced the god `create_transaction`
tool with intent-specific tools (`add_card_purchase`, `add_account_expense`, `add_account_income`). But three
write flows survived as god entry points, their ownership decision relocated into `src/diplomat/transactionRouting.ts`
rather than removed:

- `routeUpdateTransaction` re-loads the transaction and dispatches on `cardId` (card → `updateCardTransaction`,
  else core).
- `routeDeleteTransaction` re-loads and dispatches on `billId` (bill-attached → `deleteCardTransaction`, else
  core).
- `routeTransactionLine` (serving `create_transactions_bulk`) decides per line whether the card or account
  aggregate owns it.

This is the same god entry point ADR-016 killed for create, hidden one layer down. A **transitional redirect
that is calcifying into permanent architecture** — a single tool that internally figures out which context owns
the work, instead of the caller addressing the owning context directly. It re-introduces, at the composition
root, exactly the cross-domain coupling the boundary work removed from the controllers.

Crucially, the routers re-derive information the caller **already has**: `TransactionViewSchema` (returned by
`search_transactions` / reads) already exposes `cardId`, `accountId`, `toAccountId`, and `billId`. The agent that
just read a transaction already knows its owning context; the router looks it up again to make a decision the
caller could have made. The redirect is redundant, not load-bearing.

## Decision (proposed)

**Bounded-context ownership applies to every write. The only cross-cutting transaction surface is movement
*reading* (`search_transactions`, `get_spending_summary`, `aggregate_spending`, account balances) — one shared
read model over all transactions. Every mutation is an aggregate-specific tool; the composition-root ownership
routers (`routeUpdateTransaction`, `routeDeleteTransaction`, `routeTransactionLine`) and the god tools they back
are removed.**

### Write surface after this ADR

| Aggregate | Create | Update | Delete | Bulk import |
| --- | --- | --- | --- | --- |
| credit-card | `add_card_purchase` ✓ | `update_card_transaction` | `delete_card_transaction` | `import_card_statement` |
| account | `add_account_expense` / `add_account_income` / `create_transfer` ✓ | `update_account_transaction` | `delete_account_transaction` | `import_account_statement` |

(✓ = already exists from ADR-016.) `update_transaction`, `delete_transaction`, and `create_transactions_bulk`
are **removed** (breaking).

### Sub-decisions

1. **The caller addresses the owning context; the tool validates, it does not dispatch.** Each aggregate-specific
   write loads the target id and asserts it belongs to this context; a wrong-context id is a `validation` error
   carrying a redirect hint (e.g. calling `update_card_transaction` on an account movement → "this is an account
   transaction; use `update_account_transaction`"). This is a guard, not a router — the ownership *decision*
   lives with the caller, informed by the read side, never re-derived by a shared dispatcher.

2. **Reads stay cross-cutting, and that is the deliberate single exception.** The shared read model over all
   transactions is legitimate (balances/summaries/search span every movement). `TransactionView` already carries
   the owning-context discriminator (`cardId` / `accountId` / `toAccountId` / `billId`); this ADR formalizes that
   as a contract — reads MUST surface owning context so the agent can pick the right write tool — and it is
   regression-guarded, not merely incidental.

3. **Bulk becomes single-source per aggregate.** `import_account_statement { account, items[] }` targets one
   account; `import_card_statement { card, items[] }` targets one card. This matches how statements actually
   arrive (one bank export, one card export) and eliminates per-line ownership routing entirely —
   `routeTransactionLine` and the god `createTransactionsBulk` shape are removed. Each import belongs wholly to
   one aggregate and reuses that aggregate's single-line create policy.

4. **Mutation ownership is decided by bill-attachment, not merely `cardId`.** Anything attached to a bill
   (`billId` present) is governed by bill immutability, which is credit-card-aggregate policy — so
   `update_card_transaction` / `delete_card_transaction` own the mutation of any bill-attached transaction. That
   includes the bill-payment transfer (carries `billId`, no `cardId`): it is created/removed only by
   `pay_bill` / `revert_bill_payment`, so both delete tools reject a direct delete of it with a redirect to
   `revert_bill_payment` — no card/bill policy leaks into the account tools. Non-bill-attached account movements
   and ordinary transfers are owned by the account tools. (This rationalizes today's split, where update keys on
   `cardId` and delete keys on `billId`.)

## Options Considered

### Option A — Status quo: composition-root routers dispatch by inspection (rejected)
| Dimension | Assessment |
| --- | --- |
| Boundary | Half-applied — create is context-specific, but update/delete/bulk are god flows one layer down |
| Coupling | The router re-couples card+account ownership in one place the boundary work aimed to remove |
| Trajectory | A "temporary" redirect with no removal trigger — it calcifies |

**Rejected** — this is the smell this ADR exists to remove.

### Option B — Aggregate-specific write tools + validating guards + single-source bulk (chosen)
| Dimension | Assessment |
| --- | --- |
| Boundary | Complete — every write is owned by exactly one context; only reads are shared |
| Caller contract | The caller addresses the context, using the discriminator the read already returned |
| Cost | Tool surface grows (~3 god tools → ~7 specific); each is single-purpose and self-validating |

**Chosen.**

### Option C — Keep generic `update`/`delete` as core ops with injected aggregate policy hooks (rejected)
| Dimension | Assessment |
| --- | --- |
| Boundary | Still a single god tool; the caller expresses no intent |
| Mechanism | The injected hook that picks card-vs-account policy is `routeTransactionLine` by another name |

**Rejected** — moves the router, doesn't remove it.

## Trade-off Analysis

The real tension is **tool-surface ergonomics vs. bounded-context purity.** Option A/C keep a small surface (one
`update_transaction`) but at the cost of a shared component that must know every context's ownership rules — the
exact coupling ADR-016 removed from controllers, re-created at the composition root and quietly permanent. Option
B grows the surface to ~7 single-purpose write tools and requires the caller to address the owning context, but
that information is **already in hand**: the read side returns `cardId`/`accountId`/`billId`, so the natural
read→act agent flow carries the discriminator with zero extra round-trips, and each tool's description makes its
scope explicit. For an AI-first system the clarity of single-purpose, self-validating tools is worth more than a
minimal tool count, and "no god write flows" becomes a bright-line rule instead of a judgment call that erodes.
Reads remain the one shared surface by design — a stated exception, not a loophole.

The surface-growth cost is also smaller than a naive "~3 → ~7" count implies, because the split **relocates a
discriminator the caller already had to supply — it does not introduce a new decision.** For create this is
exact: the god `create_transaction` already required `type` (`expense`/`income`) and already required the caller
to choose `account` or `card`, so `add_account_expense` / `add_account_income` / `add_card_purchase` just move
that same, already-mandatory intent from a parameter value to a tool name — zero new knowledge, and a class of
invalid-argument round-trips (both `account` and `card` set) becomes unrepresentable rather than runtime-rejected.
Update/delete are the one case with a genuinely new requirement: the god `update_transaction` / `delete_transaction`
took only an `id` and let the router look the owner up, whereas the split tools need the caller to know the
owning context. But an `id` is virtually always obtained from a preceding read, and that read already returns the
`cardId`/`accountId`/`billId` — so the discriminator is in hand from the same round-trip in the normal read→act
flow; the only true new cost is a bare id with no preceding read, which is rare. Net: the added ergonomic cost is
nil for create and near-nil for update/delete, not the linear growth the tool count suggests.

## Consequences

- **Removed** (breaking): `update_transaction`, `delete_transaction`, `create_transactions_bulk` tools + their
  REST routes; `routeUpdateTransaction`, `routeDeleteTransaction`, `routeTransactionLine`, and the god
  `createTransactionsBulk` shape.
- **Added**: `update_card_transaction`, `delete_card_transaction`, `import_card_statement` (credit-card
  aggregate); `update_account_transaction`, `delete_account_transaction`, `import_account_statement` (account
  aggregate) — MCP tools and matching REST intent routes.
- **New shared shape**: an ownership-validation guard (wrong-context id → `validation` error with a redirect
  hint), used by each aggregate-specific mutation tool. It reads the transaction and checks the discriminator; it
  is a guard, not a dispatcher.
- **Read side formalized as the sole cross-cutting surface.** `TransactionView` MUST carry the owning-context
  discriminator (`cardId`/`accountId`/`toAccountId`/`billId`) — already true; add/keep a regression guard.
- **Coverage preservation is a hard gate** (as in ADR-016's create retirement): every existing acceptance/
  regression test for `update_transaction` / `delete_transaction` / `create_transactions_bulk` — whether it
  asserts on those flows or uses them as an arrange step — migrates to the specific tools with **zero net loss**;
  each PR ships a coverage-parity map.
- **Invariant** (added to `docs/architecture.md` on acceptance): *the only cross-cutting transaction surface is
  the read side; every write is an aggregate-specific entry point that validates ownership and never dispatches
  by inspection; the composition root routes nothing by re-deriving a transaction's owner.*
- **Docs**: `docs/mcp-tools.md` (tool split), `docs/architecture.md` (routers gone from the dependency table +
  the new invariant), this ADR's status on acceptance.

## Migration plan (incremental — one PR each, behind the full gate + coverage-parity map)

1. **update/delete split**: add `update_card_transaction` / `delete_card_transaction` and
   `update_account_transaction` / `delete_account_transaction` with ownership-validation guards; remove
   `routeUpdateTransaction` / `routeDeleteTransaction` and the `update_transaction` / `delete_transaction` tools +
   routes.
2. **bulk split**: add `import_card_statement` / `import_account_statement` (single-source); remove
   `routeTransactionLine`, the god `createTransactionsBulk` shape, and the `create_transactions_bulk` tool +
   route.

Each step migrates its full acceptance coverage to the new tools before deleting the old, and updates
`docs/mcp-tools.md` + `docs/architecture.md` in the same change.

## Open questions (settle during design, not blocking acceptance)

1. Tool naming: `update_card_transaction` vs `update_card_purchase` (leaning `_transaction` — update/delete act
   on any card transaction, including adjustments, not only purchases); `import_*_statement` vs
   `import_*_transactions` (leaning `_statement` — it's the real-world artifact).
2. Confirm the bill-attachment (`billId`) mutation-ownership mapping for the bill-payment transfer (sub-decision
   4) reads correctly to you, vs. treating the transfer as account-context with an explicit bill-immutability
   guard in the account delete tool.

## Action Items

1. [ ] Review/accept this ADR (decision review — no implementation in this PR).
2. [ ] On acceptance: the invariant + dependency-table update in `docs/architecture.md`.
3. [ ] Implement step 1 (update/delete split), then step 2 (bulk split) — one PR each, coverage-parity mapped.
