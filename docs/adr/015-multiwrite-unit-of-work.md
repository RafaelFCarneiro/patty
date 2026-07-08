# ADR-015: Unit-of-work deltas with optimistic row versioning for multi-write flows

**Status:** Proposed · **Date:** 2026-07-06 · **Deciders:** Rafael · Builds on the parameterized-SQL and
idempotency invariants (`docs/architecture.md`) and the intra-repo `db.transaction` pattern already in use.
Triggered by the partial-write (TOCTOU) shape recurring on PR #83 — flagged twice by review, fixed once by a
one-off reorder (commit bc1b418). Revises the earlier accepted draft of this ADR: the race guard is now
**generic optimistic versioning**, replacing per-flow domain CAS predicates, under a hard rule that **repos
stay domain-agnostic**.

## Context

Controllers orchestrate flows as read → validate → write A → write B, where A and B are each their own atomic
repo call but **the pair is not atomic**. A concurrent writer landing between A and B (or a crash) produces a
partial write: some fields committed, a later step rejected or lost. This is not hypothetical — the same shape
was flagged twice on one PR, and the codebase has **three concurrent write surfaces** against one libSQL file:
MCP (chat), the REST sidecar (**on by default** since ADR-013), and scheduled runs (`apply_due_recurring`).
SQLite serializes individual statements; it does nothing for app-level sequences.

### Survey of multi-write flows (as of `main` @ #83)

| Flow (controller) | Write sequence | Today's mitigation | Risk |
| --- | --- | --- | --- |
| `updateTransaction` | `bills.ensureAndAttach` → `transactions.update` → `merchants.strengthenFromTransaction` | bc1b418 reorder + `ensureAndAttach`'s atomic re-check | **High** — the twice-flagged flow; the reorder narrows one interleaving, the triple is still non-atomic |
| `payBill` | `transactions.create` (payment transfer) → `bills.markPaid` | none across the pair | **High** — gap leaves an orphan transfer with the bill unpaid |
| `createTransaction` (card + bill) | `transactions.create` → `bills.ensureAndAttach` → compensating `transactions.delete` on attach failure | manual compensation (saga-by-hand) + idempotent-replay self-heal (attach keyed on missing `billId`) | **Medium** — a crash between the writes leaves an unattached row until a replay self-heals it; the pair is still non-atomic |
| `applyDueRecurring` | N × `transactions.create` → `recurring.advance` | stable idempotency keys (`rec-<ruleId>-<date>`) make replay safe | **Low** — idempotent replay is a legitimate alternative to atomicity here |
| `revertBillPayment` | `bills.revertPayment` | already one intra-repo `db.transaction` | Solved |
| `createCreditCard` / `deleteCreditCard` | `createWithAccount` / `deleteCard` | already intra-repo transactions | Solved |
| category / sub-category deletes | repo methods | already intra-repo transactions | Solved |
| `deleteAccount` (and peers) | `countReferences` → `delete` | none | Adjacent guard-then-single-write TOCTOU — covered by the same versioning mechanism whenever touched |

The pattern in the "Solved" rows: whenever the whole write intent reaches one repo method, one `db.transaction`
makes it atomic. The remaining question is the **race guard** — how a flow detects that the state it validated
changed before it wrote — and that guard must not smuggle business rules into `diplomat/db`.

### The hard constraint: repos are domain-agnostic

`docs/diplomatic-architecture.md` is unambiguous: database namespaces "should contain no business logic."
A race guard expressed as a **domain predicate** (e.g. "only attach if the bill's status is not `paid`")
unavoidably violates this: the repo must fetch sibling rows, interpret domain fields, and name domain
conflicts — policy in the persistence layer, growing with every migrated flow. Whatever mechanism we choose,
**the repo may only answer mechanical questions.** The mechanical question that generalizes is: *"is this row
still the row the controller read and validated?"*

## Decision (proposed)

**Two pieces, one pattern:**

**(1) Unit of work — controllers assemble a typed, per-flow delta (the fully-decided write intent) and hand it
to ONE transactional repo method (in `diplomat/db`) that executes all writes in a single `db.transaction`.**

**(2) Race guard — generic optimistic versioning. Every mutable table gains a `version` column, bumped by
schema triggers on every update; reads return it; every conditioned write carries the expected version
(`UPDATE … SET … WHERE id = ? AND version = ?`); `rowsAffected === 0` means the row changed since it was read —
a generic `'stale'` conflict that rolls back the whole transaction. Controllers own ALL validation against the
read snapshot and, on `'stale'`, re-run the read → validate → write loop (bounded retries).** The repo checks
versions; it never checks state.

The sub-decisions:

1. **Typed per-flow deltas, in `models/`.** Each multi-write flow gets its own named write-intent type next to
   the entity's existing patch types (precedent: `TransactionPatch` in `models/transaction.ts`), carrying the
   `{ id, expectedVersion }` of every row the write set touches or guards:

   ```ts
   // models/transaction.ts — write intent for the update flow, fully decided by the controller
   export type TransactionUpdateDelta = {
     target: { id: string; expectedVersion: number };
     patch: TransactionPatch;
     refs?: TransactionRefsPatch;
     reassignment?: {
       toBill: { id: string; expectedVersion: number };
       fromBill?: { id: string; expectedVersion: number };
     };
     classificationStrengthen?: { categoryId: string };
   };
   ```

   Explicitly **no generic domain-spanning `Delta`/changeset type** — that degrades into an untyped list of
   write ops. One flow, one named type.

2. **Versioning mechanics.** `version INTEGER NOT NULL DEFAULT 0` on every mutable table (`transactions`,
   `bills`, `accounts`, `categories`, `credit_cards`, `recurring_rules`, `tags`, `dashboards`, `settings`).
   **The bump is maintained by schema-level `AFTER UPDATE` triggers** (`SET version = version + 1` — the same
   machinery already maintaining the FTS mirror in `drizzle/0001_fts5_search.sql`), NOT hand-written in each
   repo write: triggers cover every write path — query builder, raw `sql` statements, and future code — so no
   write can forget the bump (SQLite's recursive-triggers default keeps the trigger from re-firing itself).
   App code supplies only the conditioned `WHERE … AND version = ?`. `wire/db` rows and entity models carry
   `version` (internal field — **not** exposed on `wire/out` in v1; it is a concurrency token, not client
   contract). Creates are governed by the existing idempotency-key UNIQUE mechanism, not versions.

   *Built-in mechanisms surveyed and why they don't fit:* SQLite has no per-row version primitive —
   `PRAGMA data_version` is a whole-database counter (any write anywhere bumps it; cross-connection only) and
   `rowid` is identity, not version. Drizzle 0.45's `$onUpdate` column hook auto-sets values but fires only on
   query-builder updates, silently bypassed by raw `sql` writes — unacceptable for a correctness mechanism.
   A pessimistic `BEGIN IMMEDIATE` spanning read→validate→write would serialize via SQLite's single writer
   lock but requires holding a transaction (and the global write lock) across controller logic — the same
   leak-the-transaction-into-the-domain shape rejected in Option C.

3. **Guard what you validated.** The discipline that makes OCC correct across rows: every row whose **validated
   state the decision depends on** must be version-guarded inside the transaction — including rows the flow
   doesn't otherwise modify, via a version-asserting touch (a no-op conditioned update, e.g. `UPDATE bills SET
   id = id WHERE id = ? AND version = ?`; the trigger performs the bump). Example: reassigning a transaction
   validates (in the controller) that neither the source
   nor target bill is paid; the write set therefore version-guards the transaction row **and both bill rows**.
   If a concurrent `pay_bill` landed, the bill's version moved → `'stale'` → the retry re-reads, re-validates,
   and now returns the correct domain error (`paidBillImmutable`) **from the controller**.

4. **One transactional repo method per flow** (e.g. `transactions.applyUpdate(delta)`), wrapping every write in
   a single `db.transaction`. The repo's implementation is mechanical: apply each conditioned write, and on any
   `rowsAffected === 0` roll back via an internal sentinel. **Repos never import `logic/`, never read rows to
   inspect domain fields for guarding, and know exactly one conflict word.**

5. **Result ↔ `db.transaction` bridge — outcome-as-data.** (The DB unit of work, not the finance `Transaction`
   entity.) The repo API returns a typed outcome; the sentinel throw exists only internally to trigger rollback:

   ```ts
   type ApplyOutcome = { applied: true; row: TransactionRow } | { applied: false; conflict: 'stale' };
   ```

   Unexpected errors still throw through (500), as today.

6. **Controller retry loop.** On `'stale'`: re-read, re-validate (every domain rule lives here and only here),
   rebuild the delta, re-attempt — bounded (3 attempts) via a small shared helper (e.g.
   `withOptimisticRetry`), then surface a generic `conflict` AppError ("concurrent modification — retry").
   Conflicts therefore resolve into success or the correct domain error, never a partial write.

7. **Idempotent replay stays a valid alternative.** `applyDueRecurring` is NOT migrated — its stable
   idempotency keys already make partial batches safe to re-run.

## Options Considered

### Option A — Status quo: case-by-case ordering + compensation
| Dimension | Assessment |
| --- | --- |
| Effort now | Zero |
| Correctness | Narrows windows; never closes them (bc1b418 reorders; `createTransaction` compensates by hand) |
| Recurrence | High — every new multi-write flow re-derives a bespoke fix; the shape was flagged twice on one PR |

**Rejected.** The third recurrence is a matter of time; compensation-by-hand is the least reviewable fix.

### Option B — Deltas + per-flow domain CAS predicates in the repo
| Dimension | Assessment |
| --- | --- |
| Correctness | Atomic and precise (checks the exact business predicate at write time) |
| Layering | **Fails the hard constraint** — the repo must fetch sibling rows (e.g. bills), interpret domain fields (`status`), and name domain conflicts; each migrated flow teaches `diplomat/db` more policy |
| Generality | None — guards are per-flow domain knowledge |

**Rejected.** Precision is bought by moving the domain into the repo — exactly what the constraint forbids.

### Option C — Serialize app-side (single writer queue/mutex)
**Rejected** — MCP stdio, the REST sidecar, and scheduled runs can be separate processes on one libSQL file;
an in-process lock guards nothing across them.

### Option D — Deltas + generic optimistic row versioning + controller retry — **chosen (proposed)**
| Dimension | Assessment |
| --- | --- |
| Correctness | Version guards inside one `db.transaction` detect any interleaving on validated rows |
| Layering | Clean — repos know ids and integers; ALL rules live in controllers; one generic conflict word |
| Generality | One mechanism for every entity and flow; new flows add zero repo policy |
| Cost | One migration; `version` threading in `wire/db`/models; a retry helper; the guard-what-you-validated discipline; benign concurrent edits also trip `'stale'` (coarser than CAS — resolved by retry) |

## Trade-off Analysis

The tension is **guard precision vs. layer purity**. Domain CAS (B) checks exactly the business predicate at
write time, but the predicate *is* business logic — its precision is paid for with policy in `diplomat/db`,
compounding with every flow. Versioning (D) checks a proxy — "did anything I validated change?" — which is
coarser (an unrelated concurrent edit to a guarded row also trips `'stale'`) and needs a retry loop. At this
system's concurrency level (single user; rare overlaps between agent, dashboard, and scheduler), spurious
retries are near-zero and a bounded loop is cheap, while the layering win is permanent: repos stay mechanical
forever, every rule has exactly one home, and review collapses to a domain-free question — *"does the write
set version-guard every row the validation read?"* Option A avoids all cost and fixes nothing; Option C's
safety is illusory across processes.

## Consequences

- **Schema/migration:** `version` on all mutable tables; `wire/db` row schemas + `dbToModel` carry it;
  `wire/out` unchanged (v1).
- **New:** per-flow delta types (with `{ id, expectedVersion }` refs); one transactional repo method per
  migrated flow; the `withOptimisticRetry` controller helper; the generic `conflict` AppError primitive.
- **Repos get simpler as flows migrate**, not smarter: version-conditioned writes replace ordering tricks and
  hand-rolled compensation; `ensureAndAttach`-style embedded re-checks are retired in favor of controller
  validation + version guards (its mechanical bill auto-create remains).
- **Invariant (added to `docs/architecture.md` on acceptance):** *multi-write flows hand a typed delta to a
  single transactional repo method; every row whose validated state the decision depends on is version-guarded
  in that transaction; repos never read sibling state or interpret domain fields for guarding — their only
  conflict vocabulary is `'stale'`; controllers own all validation and bounded retry; idempotent replay is the
  documented alternative where keys already make replay safe.*
- **Docs in the same change (on acceptance):** the idiom ("delta in, outcome out, guard what you validated")
  in `docs/code-style.md`; the invariant in the CLAUDE.md self-review checklist (mirrored to
  `.github/copilot-instructions.md`).
- **Cost accepted:** benign-edit retries (rare here); controllers must thread `expectedVersion` for every
  validated row — enforced structurally by the delta types requiring it.

## Migration plan (incremental — no big-bang)

0. **Versioning groundwork** (may ship with the first mover): the migration + `wire/db`/model threading.
1. **First mover: `updateTransaction`** — `TransactionUpdateDelta`; `transactions.applyUpdate(delta)` absorbing
   attach/reassign + row update + merchant strengthen in one transaction, all writes version-conditioned;
   paid-bill validation stays in the controller; `withOptimisticRetry`; retire the bc1b418 ordering dependence.
2. **`payBill`**: one transactional method — create the payment transfer + mark paid, with the bill row
   version-guarded (the controller validated `status != paid` when it read it).
3. **`createTransaction`**: fold create + attach into one transaction (bill row version-guarded); delete the
   compensating-delete branch; keep the idempotent-replay self-heal semantics at the controller level.
4. `applyDueRecurring`: **no change** — documented idempotent-replay alternative.
5. Going forward: new multi-write flows adopt the idiom from day one (invariant + PR checklist).

Each step is its own PR behind the full gate, with concurrency-shaped integration tests (e.g. pay-vs-reassign
interleavings asserting `'stale'` → retry → correct outcome, and no partial writes on rollback).

## Action Items

1. [ ] Review/accept this ADR (decision review — no implementation in this PR).
2. [ ] Versioning groundwork migration + first mover (`updateTransaction`) — one PR.
3. [ ] On acceptance: `docs/architecture.md` invariant + index; code-style idiom; CLAUDE.md checklist
   (mirrored to copilot-instructions).
4. [ ] Migrate `payBill`, then `createTransaction` — one PR each.
