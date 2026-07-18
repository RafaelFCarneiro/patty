# ADR-022: The imperative shell runs effects, not just a unit of work

**Status:** Accepted (Migration plan step 1 implemented — rename + on-acceptance docs; steps 2–4 pending) ·
**Date:** 2026-07-12 · **Deciders:** Rafael · Extends **ADR-021** (Functional Core / Imperative Shell).
Renames and generalizes the shell's executor introduced there; sequences bulk import (ADR-021 phase 3c)
through the generalized runner instead of a bespoke path.

## Context

ADR-021 gave the domain the ability to return effects as data (`{ persist, response }`) and put a generic
executor in the shell — `withUnitOfWork(db, registry, flow)` — that invokes the flow, applies its persistence
batch in one `db.transaction` with version-conflict retry, and returns the response. It is named after the
database "unit of work."

The name undersells what it already is. `withUnitOfWork` **invokes the flow, executes its side effects, owns the
conflict/retry loop, and returns the outcome.** Persistence is only *one kind* of effect it runs; the response is
another (the returned outcome); message dispatch (an outbox, notifications) is a foreseeable future kind. The DB
unit of work is a *special case* of "execute the effects the model declared," not the whole abstraction — and the
name anchors the concept to the database, which is exactly the coupling FC/IS exists to avoid at the *conceptual*
level.

A concrete need forces the generalization now (it is not speculative renaming). Two flows exercise the **two
different granularities** the executor must express — one inherently a sequence of independent units, the other a
single atomic batch:

- **Bulk statement import** (phase 3c): a statement paste is partial-success by nature — import the valid lines,
  flag the invalid ones. Forcing it into one atomic batch is both wrong semantics (one bad/conflicting line
  should not roll back the rest) and the source of avoidable complexity (coordinating a shared new bill across
  lines *within* one batch).
- (Recurring's `apply_due_recurring` chose the opposite — one atomic batch across all due rules, safe because its
  `rec-<ruleId>-<date>` idempotency keys make a retried run a no-op. That is a legitimate choice for a scheduled
  maintenance op; it should remain available, not be outlawed.)

So the executor needs to express **granularity** — a single atomic unit *or* a sequence of independent units —
and the bulk path must go through that same generic executor, declaring its effects, never applying them itself.
"Loop the single flows and apply each in a controller" would put effect execution back in the domain and betray
FC/IS.

## Decision (proposed)

**Rename and reframe the shell's executor as a generic effect runner, and generalize it to execute either a
single atomic unit or a sequence of independent units.** The domain still only *declares* effects; the runner
executes them and returns their outcomes.

1. **Rename.** `withUnitOfWork` → **`runEffects`**; `diplomat/db/unitOfWork.ts` → `diplomat/db/effects.ts`. The
   term "unit of work" survives as the name of **one execution mode** (a single atomic unit), not the whole
   abstraction. Behavior of existing single-unit flows is unchanged — this part is a mechanical rename.

2. **Reframe as an effect runner.** The runner executes the **effects** a flow declares and returns the outcome.
   Effect kinds:
   - **persistence** — the `Persistable` batch (implemented today, unchanged: `modelToDb` at the handler →
     registry applier → version-guarded write).
   - **response** — the value returned to the caller (always).
   - **message dispatch** — a **named future kind** (outbox / notifications). Not built here; the runner and the
     flow contract are shaped so it can be added as another effect kind without touching the domain contract.

3. **Granularity — single atomic unit OR sequence of independent units.** A flow declares which:
   - **Atomic unit** (today's default): one `Persistable` batch applied in one transaction, all-or-nothing,
     version-conflict → retry the unit. Used by `createAccount`, `payBill`, `apply_due_recurring`, etc.
   - **Sequence of independent units**: the runner applies each unit in its own transaction, in order, collecting
     a per-unit outcome; a version conflict retries **that unit** (bounded); a per-unit domain error is recorded
     and the sequence **continues** (partial success). Used by bulk import.

4. **Sequence is driven by re-invoking the per-unit flow against committed state (option B).** For a sequence,
   the runner runs unit *i*'s flow, applies it, commits, then runs unit *i+1*'s flow against the now-committed
   state — the same re-invocation the retry loop already does. So each per-unit flow is the **existing single
   flow, verbatim**, with zero cross-unit awareness: bulk import reuses `add_card_purchase` / `add_account_*`
   per line unchanged, and the shared-new-bill "dedup" evaporates (line 2's flow simply reads the bill line 1
   committed). The alternative — one up-front declaration of all N units with the domain coordinating shared
   rows across them (option A) — is rejected: it pushes cross-unit coordination back into the domain and loses
   per-unit isolation.

5. **Outcomes.** The runner returns the response plus per-effect / per-unit outcomes (idempotency
   inserted-vs-duplicate, per-unit ok/err). Idempotency-aware and bulk responses are shaped from these (ADR-021
   rule 6, generalized to per-unit).

Repos stay agnostic and the domain stays the rules owner — unchanged. This generalizes the *executor*, not the
layer boundary.

## Options Considered

### Option A — Keep "unit of work" / single-atomic-batch only (rejected)
Misnames a component that already runs response + persistence + retry, anchors it to the database, and forces
inherently-independent flows (bulk import) into all-or-nothing semantics + within-batch coordination complexity.

### Option B — Rename to an effect runner + granularity, sequence driven by per-unit re-invocation (chosen)
| Dimension | Assessment |
| --- | --- |
| Naming/concept | Honest — the shell runs effects; persistence is one kind; DB unit of work is one mode |
| Bulk/recurring fit | Both fit generically: recurring = atomic unit; bulk = sequence of independent units |
| Domain simplicity | Per-unit flows are the existing single flows verbatim; no cross-unit dedup |
| Extensibility | A message-dispatch effect kind slots in without touching the domain contract |
| Cost | Rename churn; the runner gains a sequence mode + per-unit outcomes |

### Option C — Rename but keep single-batch-only; bulk loops in a controller (rejected)
Reintroduces effect execution inside the domain (a controller applying per line), betraying FC/IS. The thing
being generalized is precisely the *generic* executor.

## Consequences

- **Rename** `withUnitOfWork` → `runEffects`, `unitOfWork.ts` → `effects.ts`, across code, tests, and the
  canonical doc; "unit of work" is retained only as the name of the atomic-unit mode. Mechanical, behavior-
  preserving for existing flows.
- **The runner gains a sequence-of-independent-units mode** (per-unit transaction, per-unit retry, partial
  success, per-unit outcomes) alongside the atomic-unit mode; the flow declares which.
- **Bulk import (phase 3c) lands through the generic runner** as a sequence of per-line units reusing the single
  card/account flows verbatim — the bespoke via-repo path, `deps.bills.ensureOpen`, and the within-batch
  bill-cycle dedup are all unnecessary and removed.
- **Recurring is unaffected** — it stays an atomic unit (its chosen mode remains valid).
- **A future message-dispatch effect kind** has a defined home; not built here.
- **Docs**: `docs/functional-core-imperative-shell.md` reframed (the shell runs *effects* — persistence one kind,
  response always, messaging future; the executor is `runEffects`; granularity = atomic unit vs sequence);
  `docs/architecture.md` dependency-table/wording; an amendment note on ADR-021 (its runner is renamed/generalized
  here). These land on acceptance (the doc's as-built status + the literal rename are not treated as done while
  this ADR is Proposed).

## Migration plan (phased — behind the full gate)

1. **Rename** `withUnitOfWork` → `runEffects` / `unitOfWork.ts` → `effects.ts` + reframe the canonical doc
   (mechanical, behavior-preserving); add the ADR-021 amendment note and the `docs/architecture.md` update.
2. **Add the sequence-of-independent-units mode** to `runEffects` (per-unit transaction + retry + partial-success
   + per-unit outcomes), with its own generic tests.
3. **Phase 3c on the generic runner**: bulk import declares a sequence of per-line units (reusing the single
   flows); delete `ensureOpen` / the via-repo variants / the within-batch dedup.
4. **Phase 3d** (unchanged): remove the last `deps` write methods; final `docs/architecture.md` + ADR-021
   completion.

## Action Items

1. [x] Review/accept this ADR — accepted alongside the Migration plan step 1 implementation in this PR.
2. [x] On acceptance: rename PR + canonical-doc reframe + `docs/architecture.md` update + ADR-021 amendment note +
   add this ADR to the index.
3. [ ] Implement the sequence mode, then phase 3c through it, then phase 3d.
