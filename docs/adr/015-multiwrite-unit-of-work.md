# ADR-015: Unit-of-work deltas for multi-write controller flows

**Status:** Proposed · **Date:** 2026-07-04 · **Deciders:** Rafael · Builds on the parameterized-SQL and
idempotency invariants (`docs/architecture.md`) and the intra-repo `db.transaction` pattern already in use.
Triggered by the partial-write (TOCTOU) shape recurring on PR #83 — flagged twice by review, fixed once by a
one-off reorder (commit bc1b418). Sequenced **after** ADR-014 (collection pagination): that contract work
unblocks the dashboards today; this migration follows, touching a different layer (repo write paths).

## Context

Controllers orchestrate flows as read → validate → write A → write B, where A and B are each their own atomic
repo call but **the pair is not atomic**. A concurrent writer landing between A and B (or a crash) produces a
partial write: some fields committed, a later step rejected or lost. This is not hypothetical — the same shape
was flagged twice on one PR, and the codebase now has **three concurrent write surfaces** against one libSQL
file: MCP (chat), the REST sidecar (**on by default** since ADR-013), and scheduled runs (`apply_due_recurring`).
SQLite serializes individual statements; it does nothing for app-level sequences.

### Survey of multi-write flows (as of `main` @ #83)

| Flow (controller) | Write sequence | Today's mitigation | Risk |
| --- | --- | --- | --- |
| `updateTransaction` | `bills.ensureAndAttach` → `transactions.update` → `merchants.strengthenFromTransaction` | bc1b418 reorder + `ensureAndAttach`'s atomic re-check | **High** — the twice-flagged flow; the reorder narrows one interleaving, the triple is still non-atomic |
| `payBill` | `transactions.create` (payment transfer) → `bills.markPaid` | none across the pair | **High** — gap leaves an orphan transfer with the bill unpaid |
| `createTransaction` (card + bill) | `transactions.create` → `bills.ensureAndAttach` → compensating `transactions.delete` on attach failure | manual compensation (saga-by-hand) | **Medium-high** — crash between create and compensation orphans the transaction |
| `applyDueRecurring` | N × `transactions.create` → `recurring.advance` | stable idempotency keys (`rec-<ruleId>-<date>`) make replay safe | **Low** — idempotent replay is a legitimate alternative to atomicity here |
| `revertBillPayment` | `bills.revertPayment` | already one intra-repo `db.transaction` | Solved |
| `createCreditCard` / `deleteCreditCard` | `createWithAccount` / `deleteCard` | already intra-repo transactions | Solved |
| category / sub-category deletes | repo methods | already intra-repo transactions | Solved |
| `deleteAccount` (and peers) | `countReferences` → `delete` | none | Adjacent shape: guard-then-**single**-write TOCTOU — CAS-able in place, no delta needed (out of scope here) |

The pattern in the "Solved" rows is the tell: **whenever the whole write intent reaches one repo method, the
repo already wraps it in one `db.transaction` and the problem disappears.** The gap exists exactly where a
controller splits one logical mutation across several repo calls.

## Decision (proposed)

**Controllers assemble a typed, per-flow delta — the fully-decided write intent — and hand it to ONE diplomat
method that executes all writes in a single `db.transaction`, with any last-instant race guard expressed as a
data-driven compare-and-set (CAS) SQL predicate.** Rollback on conflict; the repo reports the conflict as a
typed outcome value; the controller maps it to a colocated `AppError`.

The three sub-decisions:

1. **Typed per-flow deltas, in `models/`.** Each flow that needs multi-write atomicity gets its own named
   write-intent type next to the entity's existing patch types (precedent: `TransactionPatch` already lives in
   `models/transaction.ts`). Example:

   ```ts
   // models/transaction.ts — write intent for the update flow, fully decided by the controller
   export type TransactionUpdateDelta = {
     patch: TransactionPatch;
     refs?: TransactionRefsPatch;
     reassignment?: { cardId: string; period: BillPeriod }; // cross-repo piece
     classificationStrengthen?: { categoryId: string };
   };
   ```

   Explicitly **no generic domain-spanning `Delta`/changeset type** — that degrades into an untyped list of
   write ops and moves flow knowledge into the diplomat. One flow, one named type.

2. **One diplomat method per flow consumes the delta** (e.g. `transactions.applyUpdate(id, delta)`), wrapping
   every write in a single `db.transaction`. Race guards are **CAS predicates supplied as data**, not policy the
   diplomat re-derives: conditional writes like `UPDATE … WHERE status != 'paid'` with `rowsAffected === 0`
   treated as conflict — the same mechanic as the existing idempotency `onConflictDoNothing()` convention. The
   diplomat knows *how* to apply and *whether the row matched*; only the controller knows *what that means*.

3. **Result ↔ transaction bridge — outcome-as-data at the repo boundary.** Controllers live on the neverthrow
   railway; `db.transaction` is throw-to-rollback. The bridge follows the repo convention that already exists
   (`create` → `{ transaction, created }`; `ensureAndAttach` → `Bill | null`):

   ```ts
   // repo method: throws ONLY internally to trigger rollback; never across its API
   type UpdateOutcome =
     | { applied: true; row: TransactionRow }
     | { applied: false; conflict: 'bill_paid' }; // discriminant is data, not a message

   applyUpdate: async (id, delta): Promise<UpdateOutcome> => {
     try {
       return await db.transaction(async (tx) => {
         // ...writes; on a CAS miss:
         // throw ROLLBACK_SENTINEL('bill_paid')
       });
     } catch (e) {
       if (isRollbackSentinel(e)) return { applied: false, conflict: e.conflict };
       throw e; // unexpected → 500, as today
     }
   };

   // controller: maps the data-shaped conflict to the domain error (colocated per ADR-012)
   const outcome = await deps.transactions.applyUpdate(id, delta);
   yield* guard(outcome.applied, billErrors.paidConflict(...));
   ```

   The sentinel throw exists only *inside* the repo method to trigger rollback; the repo API stays throw-free
   for expected outcomes; neverthrow stays entirely domain-side; unexpected errors still throw through (500).

### Layering check (dependency table, `docs/diplomatic-architecture.md`)

- Deltas in `models/` — models depend on schema definitions only: unchanged. ✓
- Controllers build deltas from models/logic and call injected deps: unchanged. ✓
- Diplomat consumes models (deltas) and returns models/outcomes; contains **no business logic** — the CAS
  predicate is parameterized data; the meaning of a conflict is decided by the controller. ✓ (Identical in kind
  to `ensureAndAttach` returning `null` and `create` returning `created: false` today.)
- `Deps` keeps its shape — repo interfaces gain flow methods; nothing new is injected. ✓

## Options Considered

### Option A — Status quo: case-by-case ordering + compensation
| Dimension | Assessment |
| --- | --- |
| Effort now | Zero |
| Correctness | Narrows windows; never closes them (bc1b418 reorders; `createTransaction` compensates by hand) |
| Recurrence | High — every new multi-write flow re-derives a bespoke fix; the shape was flagged twice on one PR |
| Reviewability | Poor — each fix is a subtle interleaving argument in a review thread |

**Rejected.** The third recurrence is a matter of time, and compensation-by-hand (delete on failed attach) is
the least reviewable form of this fix.

### Option B — Typed per-flow deltas + single-transaction diplomat method + CAS predicates — **chosen (proposed)**
| Dimension | Assessment |
| --- | --- |
| Correctness | Pair/triple becomes atomic; rollback on conflict; no compensation code |
| Fit | Composes three conventions the repo already has: intra-repo `db.transaction`, outcome-as-data, `rowsAffected` CAS |
| Layering | Clean — write *intent* is domain data; the diplomat stays policy-free |
| Cost | One delta type + one repo method per migrated flow; three flows to migrate |

### Option C — Expose transaction control to controllers (`withTransaction(fn)` / transactional repos in `Deps`)
| Dimension | Assessment |
| --- | --- |
| Correctness | Also atomic |
| Layering | **Leaks infrastructure lifecycle into the domain** — the controller owns BEGIN/COMMIT, contradicting "controllers are infrastructure-agnostic" |
| Hazard | Encourages long transactions spanning validation reads and `await`s — holding SQLite's single writer lock across the whole flow |
| Testability | Deps double must now simulate transaction semantics |

**Rejected.** It solves atomicity by making every controller a little transaction script; Option B keeps
transactions short (writes only) and where they already live.

## Trade-off Analysis

The tension is **atomicity vs. the "diplomat has no business logic" line**. Option C buys atomicity by moving
transaction control into the domain — wrong direction, and operationally worse on SQLite (single writer).
Option B keeps the boundary intact by splitting the concern: the **controller decides everything** (validations,
resolution, what to write, what a conflict means) and encodes it as data; the **diplomat executes** the decided
intent atomically and reports what happened as data. The residual risk of Option B is delta proliferation —
mitigated by scoping deltas per flow (only flows with ≥2 writes get one) and by the existing `TransactionPatch`
precedent. `applyDueRecurring` shows the honest boundary of the rule: where **idempotent replay** already makes
a partial batch safe to re-run, that is an acceptable, documented alternative to atomicity — batch
materialization stays as-is.

## Consequences

- **Easier:** multi-write flows become one reviewable repo method with one transaction; the compensating-delete
  saga in `createTransaction` disappears; conflict semantics become typed outcomes instead of interleaving
  arguments in review threads.
- **Harder:** each migrated flow needs its delta type + repo method + outcome mapping; contributors must learn
  the "delta in, outcome out" idiom (documented in `docs/architecture.md` + `docs/code-style.md` on acceptance).
- **New invariant (added to `docs/architecture.md` on acceptance):** *a controller flow performing more than one
  repo write MUST either hand a per-flow delta to a single transactional diplomat method, or document why
  idempotent replay makes the non-atomic sequence safe (as `apply_due_recurring` does).* Review/verifier
  checklists gain this item.
- **Out of scope, noted:** guard-then-single-write races (`deleteAccount`'s countReferences → delete) don't need
  deltas — they can adopt an in-place CAS (`DELETE … WHERE NOT EXISTS(refs)`) whenever touched next.
- No schema changes; no wire/API changes; behavior at the edges unchanged except that true conflicts surface as
  typed domain errors instead of silent partial states.

## Migration plan (incremental — no big-bang)

1. **First mover: `updateTransaction`** (the twice-flagged flow). `TransactionUpdateDelta` in
   `models/transaction.ts`; `transactions.applyUpdate(id, delta)` absorbing attach + update + merchant
   strengthen in one transaction with the paid-bill CAS; retire the bc1b418 ordering dependence.
2. **`payBill`**: fold `transactions.create` + `bills.markPaid` into one transactional method (CAS on
   `status != 'paid'`); removes the orphan-transfer window.
3. **`createTransaction`**: fold create + attach into one transaction; delete the compensating-delete branch.
4. `applyDueRecurring`: **no change** — documented as the idempotent-replay alternative.
5. Going forward: new multi-write flows adopt the idiom from day one (enforced by the invariant + PR checklist).

Each step is its own PR behind the full gate, with concurrency-shaped integration tests (pay-vs-reassign
interleavings) where feasible.

## Action Items

1. [ ] Review/accept this ADR (decision review — no implementation in this PR).
2. [ ] On acceptance: add the multi-write invariant to `docs/architecture.md` (+ index this ADR) and the idiom
   to `docs/code-style.md`.
3. [ ] Migrate `updateTransaction` (first mover), then `payBill`, then `createTransaction` — one PR each
   (after the ADR-014 pagination first mover lands).
4. [ ] Add the invariant to the self-review/verifier checklist in `CLAUDE.md`.
