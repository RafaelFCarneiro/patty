# ADR-021: Functional Core / Imperative Shell for the write path — the domain returns effects, the shell applies them

**Status:** Accepted (2026-07-13; phase 1 — groundwork + `createAccount` first mover — implemented; phases 2–3
pending) · **Date:** 2026-07-12 · **Deciders:** Rafael · **Supersedes ADR-018** (atomic bill
payment) and finally resolves the thread ADR-015 opened. Adopts the principle documented in
`docs/functional-core-imperative-shell.md` for every write flow.

## Context

Every write flow in this codebase drives its own persistence: controllers `await` injected repo write methods
(`deps.transactions.create`, `deps.bills.markPaid`, `deps.bills.ensureAndAttach`) inside their `safeTry` flow.
That single fact — **the domain executes writes** — is the root cause of a problem this project has circled
repeatedly:

- **ADR-015** (rejected) tried to make multi-write flows atomic by adding a transactional repo method that
  applied a typed delta with CAS guards. It leaked domain rules into `diplomat/db`.
- **ADR-016/017/019/020** removed the *cross-domain* coupling by fixing bounded contexts, shrinking the
  multi-write surface to one flow (`payBill`).
- **ADR-018** then closed that one flow with a transactional `bills.pay` method — and re-introduced the exact
  ADR-015 smell at aggregate scale: the *repo* now knows a bill payment is "insert a transfer + flip the bill
  status." Tests like `billsEnsureAndAttach`, `addCardPurchaseSelfHeal`, and
  `updateCardTransactionReassignAtomicity` (under `test/integration/db/`) — and the bill-payment atomicity test
  ADR-018 would add — exist **only because** business flow and its atomicity concerns live
  in the repository layer.

As long as the domain applies its own writes, atomicity has nowhere to live but inside the repo, so the repo
keeps accreting business knowledge. The fix is not a better repo method — it is to **stop the domain from
applying writes at all.**

## Decision (proposed)

**Adopt Functional Core / Imperative Shell for the entire write path (`docs/functional-core-imperative-shell.md`).
Controllers become pure decisions: they read (injected queries), validate, and return
`ResultAsync<{ persist: Persistable[]; response: T }, AppError>` — a description of the writes plus the response —
without performing any write. A generic, versioned Unit of Work in the diplomat shell applies the batch in one
`db.transaction` and returns the response. Repos hold no business process; concurrency is a generic `version`
guard on the model.**

1. **`Persistable`** — a discriminated union over an `EntityTag` enum, wrapping a domain model + intent:
   `{op:'insert', entity, model}` / `{op:'update', entity, model /*carries version*/}` /
   `{op:'delete', entity, id, version}`. Built by the core in model vocabulary; the shell runs each through the
   existing `modelToDb` adapter and the matching table op.

2. **Controllers return effects, not perform them.** `safeTry` still short-circuits validation on the error
   track; reads stay injected (`deps.<x>.get/find/search`). The write calls (`deps.x.create/update/...`) are
   replaced by *accumulating a `Persistable`*. Flows compose by **merging** `persist` arrays (e.g. `payBill`
   calls the transfer controller, takes its `persist`, adds its own bill `update`, returns the merged batch).

3. **The Unit of Work (diplomat shell, `diplomat/db`).** `withUnitOfWork(deps, () => controller(deps, input))`:
   invoke the controller; apply its `persist` batch in one `db.transaction` (`modelToDb` + insert /
   version-guarded update / version-guarded delete; inserts honor the existing idempotency
   `onConflictDoNothing`); on any `rowsAffected === 0` version mismatch, roll back and **re-invoke the
   controller** (fresh reads → fresh decision) up to a bounded number of attempts, then return a generic
   `conflict` `AppError`. The shell owns atomicity, versioning, and retry — generically, once.

4. **`version` column on every mutable table** (migration). Reads surface it on the model; the shell bumps it on
   every update/delete. It is an internal concurrency token (not `wire/out`).

5. **`deps` loses its write methods.** After migration `deps` exposes queries + `newId`/`clock`/`locale` only;
   the per-flow transactional repo methods (`create`, `update`, `markPaid`, `ensureAndAttach`, `revertPayment`,
   `pay`, …) are deleted in favor of the generic applier.

6. **Idempotency-aware responses.** Flows whose response depends on apply outcome (bulk import: created vs
   duplicate-skipped) receive the shell's per-item batch outcome and shape their response from it; all other
   flows return a fully core-derived response.

## Options Considered

### Option A — Status quo / ADR-018: domain drives writes via transactional repo methods (rejected)
Atomicity lives in the repo, so the repo learns each business process. Every new multi-write flow re-derives a
bespoke transactional method and its atomicity tests. The coupling this project keeps rediscovering.

### Option B — Functional Core / Imperative Shell; core returns `Persistable[]`, shell applies (chosen)
| Dimension | Assessment |
| --- | --- |
| Repo knowledge | Zero business process — a generic versioned applier |
| Atomicity/concurrency | Generic, owned by the shell once (one transaction + `version` guard + retry) |
| Domain purity | Controllers are pure decisions over injected reads; writes are returned data |
| Testability | Flow tests assert on returned effects (no DB); the UoW is tested once |
| Cost | Large re-architecture of the write path; a `version` migration; a `Persistable`/UoW abstraction |

### Option C — Keep ADR-018's `bills.pay`, accept repo-held process for "just this flow" (rejected)
It is never just one flow — this is the fourth time the same coupling has appeared (create self-heal, ensure-and-
attach, update reassign, bill pay). Accepting it cements the smell and the tests that come with it.

## Trade-off Analysis

The tension is **a large, foundational re-architecture vs. a permanently clean write boundary.** Option A/C are
cheap per-flow but pay forever: the repo is on the business-critical path, every multi-write flow needs a bespoke
transactional method, and each ships atomicity tests that only exist because the flow applies its own writes.
Option B is a real investment — a `version` migration, a `Persistable` union, a generic UoW, and converting every
write flow — but it buys a boundary where the repository is swappable and dumb, atomicity/concurrency are solved
once generically, domain flows are pure and tested without a database, and the class of leaked-process tests
disappears. Given the write path is the heart of a finance app and this coupling has recurred four times, the
investment is warranted. The main risks are bounded and known: the `Persistable` union must stay typed
(entity-tagged models, not a god-changeset — call it out in review), and read-your-own-writes within a single
flow is not supported (reads happen before the write batch) — acceptable here, where every flow is
read → decide → write with version guards.

## Consequences

- **Supersedes ADR-018.** `bills.pay` is not built (or is reverted if merged); `payBill` returns a `persist`
  batch (`insert` transfer + version-guarded `update` bill to `paid`); the shell applies it atomically. The
  status-conditioned write becomes the generic `version` guard.
- **Closes the ADR-015 thread for good.** The concurrency mechanism ADR-015/016 groped for (versioning, CAS-as-
  data) lands in its correct home: a `version` field the core returns on the model, enforced by a generic shell —
  never in the repo.
- **Removed**: per-flow transactional repo methods and their atomicity/self-heal tests
  (`billsEnsureAndAttach`, `addCardPurchaseSelfHeal`, `updateCardTransactionReassignAtomicity`, and the
  bill-payment atomicity test ADR-018 would have added); `deps` write methods.
- **Added**: `version` columns (migration); `Persistable`/`EntityTag`; `withUnitOfWork` + the generic applier; a
  generic `conflict` `AppError`.
- **Docs**: `docs/functional-core-imperative-shell.md` becomes mandatory reading; `docs/architecture.md` and
  `CLAUDE.md` reference it as such (like `docs/diplomatic-architecture.md`); `docs/code-style.md` gains the
  return-effects-not-perform-them controller pattern.

## Migration plan (phased — this is large; each phase behind the full gate)

1. **Groundwork**: `version` migration on mutable tables; `Persistable`/`EntityTag`; the generic versioned
   applier + `withUnitOfWork`; wire it for **one** simple flow end-to-end (e.g. `createAccount`) to prove the
   shape. Old repo write methods remain for unconverted flows.
2. **Transaction + bill flows**: convert `add_*`/`update_*`/`delete_*`, `payBill`/`revertBillPayment` to return
   `persist`; delete `bills.pay`/`ensureAndAttach`/self-heal and their atomicity tests; `payBill` composes the
   transfer controller's `persist`.
3. **Remaining flows**: bulk import (idempotency-aware outcomes), recurring, card/category/tag CRUD; remove write
   methods from `deps`; delete the now-dead transactional repo methods.
4. Update `docs/architecture.md` (dependency table: domain returns effects; shell applies), the mandatory-doc
   references, and `docs/code-style.md`.

Each converted flow's test moves from "apply + assert DB state" to "assert the returned `persist` batch"; the UoW
gets its own generic atomicity/conflict/idempotency suite.

## Action Items

1. [x] Review/accept this ADR (decision review — no implementation in this PR).
2. [x] On acceptance: add this ADR to the `docs/architecture.md` index; reference
   `docs/functional-core-imperative-shell.md` as mandatory in `docs/architecture.md` + `CLAUDE.md` (alongside
   `docs/diplomatic-architecture.md`); flip that doc's status note to adopted.
3. [x] Do NOT merge `feat/atomic-bill-payment` (ADR-018) — it is superseded by this decision (PR #111 closed).
4. [ ] Implement phases 1–3 (groundwork → transaction/bill flows → remaining), behavior-preserving where the
   surface allows, coverage moved to core-level effect assertions + the generic UoW suite.
   - [x] Phase 1 (groundwork): `version` migration on all mutable entity tables; `Persistable`/`PersistOp`
     (`models/persistable.ts`) — generic over the entity's own tag/model, not a closed union, so the shared
     file never lists an entity itself; each entity owns its own tag constant on its own model file (e.g.
     `models/account.ts`'s `ACCOUNT_ENTITY_TAG`); the generic versioned applier + `withUnitOfWork`
     (`diplomat/db/unitOfWork.ts`) dispatches via an `ApplierRegistry` (entity tag → `EntityApplier`) assembled
     once at the composition root, so the engine itself never names a specific entity either — with its own
     atomicity/conflict/retry/idempotent-insert/agnostic-dispatch suite; `createAccount` converted end to end
     (MCP + REST) as the first mover — proves the shape.
   - [ ] Phase 2 (transaction + bill flows): convert `add_*`/`update_*`/`delete_*`, `payBill`/
     `revertBillPayment`; delete `bills.pay`/`ensureAndAttach`/self-heal and their atomicity tests.
   - [ ] Phase 3 (remaining flows): bulk import, recurring, card/category/tag CRUD; remove write methods
     from `deps`; delete the now-dead transactional repo methods; update `docs/architecture.md` accordingly.
