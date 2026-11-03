# ADR-016: Domain/context boundaries — aggregate ownership over a shared transaction core

**Status:** Accepted (2026-07-10; implemented — decomposition steps all merged) · **Date:** 2026-07-09 ·
**Deciders:** Rafael · Supersedes **ADR-015** (rejected before
implementation). Prerequisite for reopening the concurrency question ADR-015 raised: the multi-write surface is
expected to shrink once ownership is corrected, so boundaries are decided first and any remaining atomicity
need is scoped afterward.

## Context

The transaction controller has become the de facto entry point for every money movement, and it has absorbed
domain knowledge that belongs to other contexts. Concretely, on `main`:

- `src/controllers/transactions.ts` is the largest controller and imports `../logic/bill.js` (from `src/logic/bill.ts`)
  (`billPeriodFor`, `billPeriodForCycle`, `isBillPaid`, `BillPeriod`). Inside `createTransaction` it computes a
  bill cycle from a card's `closingDay`/`dueDay`, guards paid-bill immutability, and calls
  `bills.ensureAndAttach` with hand-rolled compensation. That is **credit-card domain policy living in the
  transaction controller.**
- `src/controllers/credit-cards.ts` is **card CRUD only** — it owns none of the card-transaction or
  bill policy that logically belongs to it.
- `src/controllers/transfers.ts` and `src/controllers/bills.ts` reach *down* into `deps.transactions.create(...)`.

So the dependency arrows are inverted from the domain: the credit-card and account concepts live inside the
transaction layer, while the credit-card/account controllers are thin bystanders. A credit-card purchase
enters through `create_transaction` (which then does bill math), not through the credit-card context.

This surfaced sharply while trying to add concurrency guarding (ADR-015): the flows that need atomic guards are
non-atomic largely *because* the wrong module owns them. A "multi-write" like `createTransaction`+bill-attach
is really a **cross-domain** write reaching from the transaction layer into bill policy, and every concurrency
mechanism tried (repo CAS predicates, then row versioning) had to smuggle bill rules into `diplomat/db` to
work. The concurrency mechanism was treating a symptom of a boundary problem.

Note what is **already correct** and should be preserved:

- The `models/` layer is already split per-entity (`src/models/credit-card.ts`, `src/models/bill.ts`,
  `src/models/account.ts`, `src/models/transaction.ts`) with colocated errors (ADR-012). The *visible* entanglement is
  in **controllers/logic and the create/update flows** — but this does not exempt the model (or adapter/wire)
  layers from the boundary: the ownership rule below governs where **new** structures land too. A card- or
  bill-shaped type (e.g. `AddCardPurchase`) belongs to the credit-card context's model namespace
  (`src/models/credit-card.ts`), never nested under `src/models/transaction.ts`; the same holds for its adapter and wire
  schema. (This is not hypothetical — a first cut of the credit-card purchase / bill-policy extraction created
  card model structures under the transaction model and had to be corrected.)
- `createTransfer` (in `transfers.ts`) already owns account-domain validation (non-credit legs, currency match,
  distinct accounts) and merely *uses* `transactions.create` to persist — this is exactly the target shape and
  becomes the template.
- There is one physical `transactions` table, and balances/summary/aggregate/search legitimately read **across
  all** transactions regardless of origin. That shared read side is a feature, not leakage.

## Decision

**Establish explicit aggregate ownership over a shared transaction core. The context that owns a money movement
is its entry point and owns its validation; it *uses* the transaction core to persist. The transaction core owns
row integrity and the cross-cutting read side, and knows nothing about bills or cards.**

Three parts:

1. **Transaction core** — owns transaction row integrity (amount sign vs. `type`, currency present,
   idempotency, date-aware `pending|effective` status, tags, classification persistence) and the shared,
   cross-cutting **read side** (balances, `get_spending_summary`, `aggregate_spending`, `search_transactions`).
   It exposes core write primitives (persist/patch/delete a transaction row + its tags) that aggregates call. It
   imports **no** bill or card logic. This is the module the dependency arrow must point *toward*, never *from*.

2. **Credit-card aggregate** — owns card CRUD **and** card purchases **and** the entire bill lifecycle and its
   policy: bill-period computation from `closingDay`/`dueDay`, paid-bill immutability, attach-to-open-bill,
   `pay_bill`/`revert_bill_payment`. A card purchase enters here. It validates (paid-bill, exclusivity), then
   calls the transaction core to persist the row and owns the bill row/attachment in the same aggregate.

3. **Account aggregate** — owns account CRUD **and** account expenses/income **and** transfers (the two-leg
   pairing already in `createTransfer`). An account movement enters here; it validates account rules, then uses
   the transaction core to persist.

**New dependency invariant (the arrow this ADR fixes):** aggregates (`credit-card`, `account`) may depend on
the transaction core; **the transaction core must not depend on any aggregate** — no `logic/bill.js` or
card/bill imports in the transaction core or its logic. Enforced in the dependency table and (ideally) an
ESLint import-boundary rule.

**The boundary is context-wide, not controller-only.** This is a semantic division of the domain into bounded
contexts (credit-card, account, transaction core), and it runs through **every layer** — `models/`, `logic/`,
`adapters/`, `wire/*`, `controllers/`, and `diplomat/db` repos alike. A structure that belongs to the
credit-card context lives in that context's namespace at each layer (`models/credit-card.ts`,
`adapters/credit-cards.ts`, the card wire schemas, `controllers/credit-card/*`); it is never placed under, or
nested inside, the transaction core's equivalents merely because a card movement is also a transaction. The
module map below is illustrated with `controllers/` for brevity, but "aggregate ownership" means ownership of
the entity's full vertical slice — schema, translation, validation, persistence — not just its controller.

**Module structure** — split by aggregate, separating aggregate-specific files from the shared core, per the
folder-over-monolith intent:

```
controllers/
  transaction/        # shared core: integrity + persistence primitives + read side
    core.ts           #   persist / patch / delete row + tags (no bill/card knowledge)
    read.ts           #   search / summary / aggregate / balances
  credit-card/
    credit-card.ts     #   card CRUD
    creditCardTransaction.ts  #   card purchase (owns bill-period + paid guard + attach)
    bill.ts           #   bill lifecycle (get / pay / revert)
  account/
    account.ts        #   account CRUD
    transfer.ts       #   transfer (two-leg pairing) + account expense/income
```

(Exact file boundaries are a design-time detail; the invariant is core-vs-aggregate separation and the
one-way dependency, not the precise filenames.)

**MCP tool surface — split `create_transaction` into intent-specific tools mapped 1:1 to aggregate entry
points** (per the decision to split rather than keep one routing tool):

| Today | After | Owner |
| --- | --- | --- |
| `create_transaction` (routes account/card by args) | `add_account_expense` / `add_account_income` (account movement) | account aggregate |
| `create_transaction` (with `card`) | `add_card_purchase` (card + bill) | credit-card aggregate |
| `create_transfer` | `create_transfer` (unchanged) | account aggregate |
| `create_transactions_bulk` | `create_transactions_bulk` (routes each line to the right aggregate) | import surface over both |

**Movement kinds are separate tools, not one tool with a `type` field** — `add_account_expense` and
`add_account_income` are distinct, mirroring the natural-language intents the agent forms ("I spent…" vs. "I got
paid…") rather than making the model set a discriminator. The god `create_transaction` is replaced by these
intent-specific tools. This is a **breaking change to the tool contract** — consumers (dashboards, clients,
docs) migrate in the same arc.

## Options Considered

### Option A — Status quo: transaction controller as the god entry point (rejected)
| Dimension | Assessment |
| --- | --- |
| Cohesion | Poor — bill/card policy lives in the transaction layer; card/account controllers are hollow |
| Dependency direction | **Backwards** — the shared core knows about bills and cards |
| Downstream cost | Every cross-cutting concern (here: concurrency) must reach across domains to work (ADR-015) |

**Rejected** — this is the state ADR-015 exposed as the root cause.

### Option B — Aggregate ownership over a shared transaction core (chosen)
| Dimension | Assessment |
| --- | --- |
| Cohesion | Each context owns its movements + policy; the core owns integrity + reads |
| Dependency direction | Correct — aggregates → core; core → nothing domain-specific |
| Shared read side | Preserved — one table, one cross-cutting read module |
| Cost | Controller/tool split; a breaking tool-surface change; one migration arc |

**Chosen** — moves policy up to its owner while keeping the genuinely shared table and its read side shared.

### Option C — Fully separate stores per aggregate (card transactions and account transactions in different tables) (rejected)
| Dimension | Assessment |
| --- | --- |
| Cohesion | High per aggregate |
| Shared read side | **Broken** — balances/summary/search must union across tables; every report re-joins |
| Fit | Over-fragments one genuinely shared entity; the movement *is* one concept with different owners |

**Rejected** — the read side is the reason the shared table exists; splitting the store trades one leak for a
worse one.

## Trade-off Analysis

The tension is **domain cohesion / correct dependency direction vs. one physically shared table with a
cross-cutting read side.** Option A keeps a single write path but cements the backwards dependency (and made
ADR-015 unimplementable cleanly). Option C maximizes cohesion but shatters the shared reporting surface that
balances, summaries, and search depend on. **Option B is the split that keeps both wins that matter:** move
*policy and entry points* to the owning aggregate (so the core stops knowing about bills/cards and the arrow
points aggregate → core), while keeping the *table and its read side* shared and cross-cutting. The cost — a
controller/module split and a breaking tool-surface change — is bounded and paid once, and it is a prerequisite
for the concurrency question to even be answerable without leaking rules into the repo.

## Consequences

- **Easier:** each context is understood and changed in one place; the transaction core is small, pure about
  integrity, and reusable; adding a new movement type (e.g. a future "investment") is a new aggregate over the
  same core, not another branch in a god controller.
- **The rejected ADR-015 concurrency question is re-scoped, not answered.** After this, most surveyed
  "multi-write" flows collapse into a single aggregate over one repo transaction; the main genuinely-remaining
  within-aggregate multi-write is `pay_bill` (payment transfer + mark-paid). Concurrency is revisited **after**
  this lands, in a new ADR scoped to that residue — if it's still worth a mechanism at single-user scale.
- **Breaking tool-surface change.** `create_transaction` is replaced by intent-specific tools; `docs/mcp-tools.md`,
  the dashboards, and any client using it migrate in the same arc. Sequence the change so old and new don't half-exist.
- **New invariant** (added to `docs/architecture.md` dependency table on acceptance): aggregates may depend on
  the transaction core; the transaction core (and its logic) must not import any aggregate's bill/card logic.
  The boundary is **context-wide** — an entity's structures live in its own context namespace at every layer
  (`src/models/`, `src/logic/`, `src/adapters/`, `src/wire/*`, `src/controllers/`, `src/diplomat/db`), never nested under the transaction
  core's equivalents; a card/bill type under `src/models/transaction.ts` is a boundary violation, not just a
  controller one. Consider an ESLint import-boundary rule to enforce it.
- **`src/logic/bill.ts` stops being imported by the transaction controller** (imported today as `../logic/bill.js`); bill policy is imported only within
  the credit-card aggregate.
- **Docs in the same change:** `docs/architecture.md` (boundaries section + dependency table), `docs/mcp-tools.md`
  (tool split), `docs/canonical/code-style.md` if a new aggregate/core convention is added, this ADR's status on acceptance.

## Open questions (settle during design, not blocking acceptance)

1. Where bulk-import routing lives — a thin import surface that dispatches each line to the owning aggregate, vs.
   a core batch primitive the aggregates share.
2. Whether the transaction core is exposed as controller functions, repo primitives, or both.
3. Vocabulary in the docs: "aggregate" (DDD) vs. "context" vs. "module" — pick one and use it consistently.

**Decided:** movement kinds are separate intent-specific tools (`add_account_expense` / `add_account_income`),
not one tool with a `type` discriminator.

## Action Items

1. [ ] Review/accept this ADR (decision review — no implementation in this PR).
2. [ ] On acceptance: dependency-table invariant + boundaries section in `docs/architecture.md`.
3. [ ] Incremental implementation, each its own PR behind the full gate:
   - Extract the transaction **core** (integrity + read side) from `transactions.ts`; no behavior change.
   - Move the **card purchase** flow + bill policy into the credit-card aggregate; split its MCP tool
     (`add_card_purchase`); remove `logic/bill.js` from the transaction layer.
   - Move **account expense/income** into the account aggregate; split its MCP tool(s).
   - Fold **transfer** (already close) under the account aggregate; retire the god `create_transaction` tool.
   - Migrate `create_transactions_bulk` routing.
4. [ ] After boundaries land: re-open the concurrency question (new ADR) scoped to `pay_bill`'s residual
   within-aggregate multi-write, if still warranted.
