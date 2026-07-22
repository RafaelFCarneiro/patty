# ADR-023: An applier decides nothing — the last domain rules leave the persistence layer

**Status:** Accepted · **Date:** 2026-07-19 · **Deciders:** Rafael · Extends **ADR-021** (Functional Core /
Imperative Shell) and **ADR-022** (the effect runner). Closes the gap those two left open: the domain no longer
*executes* writes, but two `EntityApplier`s still *decide* things while performing them.

## Context

ADR-021/ADR-022 made the domain structurally incapable of writing — every repo interface is read-only, `Deps`
carries no write method, and every mutation is a `Persistable` the core returns and `runEffects` applies. The
layer boundary holds.

What it does not yet guarantee is that the shell, once handed a `Persistable`, merely *applies* it. Eight of the
ten registered appliers do: seven are `versionedTableApplier(table)` or a thin wrapper adding conflict handling
(`billApplier`, `settingsApplier`, `tagApplier`), and `dashboardApplier` is a small hand-written one because
`dashboards` keys on `name` rather than `id`. All eight write one table and decide nothing. Two do more:

**`transactionApplier` (`diplomat/db/repos/transactions.ts`) writes three tables** — `transactions`, `merchants`,
and `transaction_tags` — and makes two decisions on the way:

1. **It brings a merchant into existence.** `if (entity.merchantKey) tx.insert(merchants)…onConflictDoNothing()`,
   on both `insert` and `update`. "A transaction carrying a merchant key implies a `merchants` row" is a domain
   fact about how that entity is created, asserted by another entity's applier.

2. **It resolves tag names and silently drops the ones that miss.** `attachTags` runs
   `select … where name in (…)` — a **read that decides something**, inside a write — then attaches whatever
   matched. Names that resolve to nothing are discarded without a word: `if (matches.length === 0) return`, plus
   the per-name misses `inArray` swallows on its own. Every other reference in the system (account, category,
   card) raises an expected error when it doesn't resolve (`controllers/resolve.ts`); tags are lenient because
   the query shape made them so, not because anyone decided it. The controllers pass raw user input straight
   through — `tagNames: input.tags ?? []` on create, `input.tags ?? existing.tags` on update — and never inspect
   it, so no flow test can assert what happens to an unknown tag; the behavior exists only in infrastructure.
   `models/transaction.ts` currently rationalizes this as *"`tagNames` is persistence structure … not a business
   decision"*; resolving user-supplied names to entities, and choosing what happens when they don't resolve, is
   a business decision.

**`merchantCategoryApplier` (`diplomat/db/repos/merchants.ts`) writes two tables** and hardcodes two domain
values: the learning weight (`weight: 1` on insert, `weight = weight + 1` on conflict) and the edge's `origin`
(always `ClassificationMethod.enum.history` on insert, and never updated on the conflict path — even though the
column's own type admits `rule` as well, so the applier is choosing one of two legitimate domain values).
`logic/merchant.ts`'s `resolveMerchantCorrection` decides *which* edge to write; infrastructure decides *how much*
it is worth and *what kind* it is.

These are not new violations — they predate the migration and simply were not what ADR-021/022 were looking at.
But they are the same failure mode those ADRs exist to remove, one layer down: a business process encoded in a
persistence handler, where it cannot be tested, cannot be changed without touching infrastructure, and is invisible
to the flow that owns it.

There is a second, structural cost. `transactionApplier` is bespoke — ~90 lines with its own doc comment
explaining why it cannot be `versionedTableApplier` — and it gives three reasons: the merchant upsert and tag
handling above, the `idempotency_key` conflict target, and the post-write read-back that lets an
idempotency-aware flow return the display-joined view. Every one of them is addressed below. The bespoke applier
is a *symptom*, not a requirement.

## Decision

**An applier decides nothing and performs no reads at all.** It receives an already-row-shaped model and
performs the mechanical write, identically for any entity following the shared conventions. Every value it
persists was chosen by the core; every entity it touches was named by the core as its own `Persistable`.

An earlier revision of this rule read "…and reads nothing *in order to decide*" — a qualifier that turned out
unadjudicatable in review (any read can be argued "mechanical"), so step 3 sharpened it away: the applier's
answer to "may I read?" is flatly no. The read that legitimately remains lives in the *engine*, not in
appliers — the single registered `readBack` projection hook, plus the engine's own surviving-row lookup that
feeds it on an idempotent duplicate (decision 4): engine machinery an entity opts into by registration, capped
and recorded as a deviation, never code an applier carries.

Note what this rule is *not*: it is not "every applier is generated by `versionedTableApplier`". `dashboards`
has a hand-written applier today and keeps it; `merchants` gets one below. Hand-written is fine — deciding is
not.

1. **`merchants` becomes an entity of its own.** A `MERCHANT_ENTITY_TAG`, a model of `{ key: string }`, and an
   applier that inserts one table with `onConflictDoNothing`. `merchants` is keyed on `key` with no `version`,
   so — like `dashboards` — it supplies its own small applier rather than `versionedTableApplier`; it still
   writes one table and decides nothing. Any flow whose decision implies a merchant — a classified transaction,
   a learning edge — emits that `Persistable` alongside its own and lets the batch merge them (rule 5). Neither
   `transactionApplier` nor `merchantCategoryApplier` writes `merchants` again.

2. **The merchant-learning edge carries its own weight and origin.** `MerchantCategoryEdge` gains
   `weightDelta: number` and `origin: ClassificationMethod`; `resolveMerchantCorrection` sets them (`1` and
   `history` — today's values, now stated in `logic/`). The applier applies what it is handed on both paths:
   `weight: weightDelta` and the given `origin` on insert, `weight = weight + weightDelta` on conflict.

   **`origin` on the conflict path is a live question this ADR settles deliberately:** today it is written on
   insert and never touched again, so an edge first learned as a `rule` stays `rule` no matter how many user
   corrections reinforce it. That is defensible (provenance of first observation) but it was never chosen — it
   is what `onConflictDoUpdate({ set: { weight } })` happened to do. **Keep today's behavior**: `origin` is
   insert-only, now stated in the applier's contract rather than implied by an omitted column.

   The delta stays a **delta**, not an absolute the core computes from a read: `merchant_category` is keyed by
   `(merchantKey, categoryId)` and carries no `version`, so the SQL-side increment is what makes concurrent
   corrections to the same edge compose instead of clobbering each other. This is effects-as-data, not
   infrastructure knowledge — the core owns the amount and the kind; the shell owns only the atomicity of
   applying it. **A delta is not idempotent under replay** the way an absolute value is; it is safe here because
   a conflict rolls the whole transaction back before any delta lands, and because the sequence mode never
   re-runs a unit that already committed. Any future execution mode that replays a committed unit must revisit
   this.

3. **Tag links become their own entity, resolved by the core.** The core resolves names → ids and emits one
   `TRANSACTION_TAG_ENTITY_TAG` `Persistable` carrying the full desired set; its applier makes `transaction_tags`
   match that set. Like `merchant_category`, this entity has no `id`/`version` of its own — it is a link table,
   and the effect is a **set-replace** rather than a row `update`, which the generic `Persistable` shape already
   accommodates.

   Set-replace is not the applier picking a diff strategy: the core states the exact desired end-state, exactly
   as an `update` states a row's desired end-state, and "make it so" is mechanical either way. What was a
   decision is the *resolution* that preceded it, and that is what moves.

   **Resolution needs a repo method that does not exist yet.** `TagsRepo` exposes `list`, `findByName` (single),
   and `findById` — no bulk name→id lookup. The core will use **`list()`** and match in `logic/`: one read, no
   N+1, and at personal-finance tag counts the full list is trivially small. This keeps the matching itself pure
   and testable, which is the point.

   **Leniency is preserved and becomes explicit**: unknown tag names are still dropped, but the core drops them,
   in `logic/`, with a test. This is behavior-preserving by decision, not by accident — the point is ownership,
   not a behavior change.

   **As built, the `Persistable` carries `{ transactionId, tagIds }` — the shape this decision originally
   specified — and the duplicate path is settled by semantics, not by resolution.** Step 2 had swapped the
   handle for `idempotencyKey`, because a create flow's own `entity.id` is a fresh `deps.newId()` mint on
   *every* invocation: on a duplicate-idempotency-key resubmission the transaction insert no-ops and the minted
   id names a row that was never inserted, so a set addressed by it can't reach the surviving row — the key,
   stable across submissions, could, via a `SELECT` inside the applier. Step 3 removed that read by deciding the
   duplicate path differently: **a duplicate replay never touches tags** (the same first-write-wins treatment
   the rest of the row already gets), so the set has no surviving row to reach in the first place. The applier
   applies the set to the id it was handed; when that row doesn't exist — the FK miss on the link insert, the
   duplicate-replay signature — it no-ops with `applied: false`, an error-translation registration of the same
   class as `billApplier`'s cycle-uniqueness rethrow, not a read and not a decision. Two related consequences
   for a flow's `response`: `PersistOutcome.read.tags` still can't reflect a same-batch tag write (the
   transaction's own read-back runs first), so the flow composes its matched-name result onto the
   DB-round-tripped view — but **only when the tag-set `Persistable`'s OWN outcome reports `applied: true`**
   (`logic/tag.ts`'s `overlayResolvedTags`, checking `outcomeFor(TRANSACTION_TAG_ENTITY_TAG, outcomes)` — not
   the transaction write's `applied`/`created` flag, which review caught as an insufficient proxy: an FK miss
   on the link insert also fires when a referenced tag is deleted concurrently between resolution and the
   batch committing, a case the transaction's own outcome can't see). On any no-op — duplicate replay or a
   genuine race — the read-back view's own `tags` are left alone. See `docs/write-path.md`'s
   `transactionTag` entity bullet for the full account.

   **Also as built: `resolveTagLinks` is conditional on `input.tags` actually being provided, not called
   unconditionally on every create/update.** An initial implementation called it (and therefore `deps.tags.list()`
   and a `transactionTagApplier` round trip) on every single write regardless of whether the caller ever
   mentioned tags — measurably slower under bulk writes (a 120-row statement import pushed a CI hook past its
   timeout) for no behavioral benefit, since a write that never mentions tags has nothing to overwrite. Omitted
   `input.tags` now short-circuits to no read and no `Persistable`; the overwrite-on-duplicate semantic below
   still holds whenever the resubmission actually includes a `tags` field.

4. **Idempotency treatment moves from the appliers to the generic mechanism — wholly.** `applyPersistable`
   used to disclaim it (*"Idempotent-duplicate handling is the applier's own concern"*); it is the engine's.
   `versionedTableApplier(table, { idempotencyColumn, readBack })` conflict-targets that column when the row
   carries a value for it and falls back to `table.id` when it does not — so "if a key is informed, apply the
   idempotent path" holds for any entity, expressed as **registration**, never a branch inside the engine
   (rule 3). `Persistable` itself is unchanged: the key is already a column on the row.

   `readBack` is the entity's own post-write projection, supplied at registration — `transactions` needs the
   display-joined view, which a generic applier cannot produce. The outcome-dependent by-id/by-key branch this
   decision originally described no longer exists: on a detected duplicate the engine's generic machinery
   resolves the surviving row's id itself (one `SELECT id … WHERE <column> = ?` — the query that used to live in
   `fetchTxByIdempotencyKey`, executed by the engine, never by an applier or by the hook), so `readBack` always
   receives the id of the row that actually persisted and reads by it, unconditionally. What remains of the
   concession is precisely this: **a projection read executed inside the engine, capped at one hook** — a
   second entity-supplied hook is the signal that this decision was wrong and Option D below is the answer.

   This concession is **not covered by the canonical doc** and must not be presented as if it were: FC/IS rule 6
   permits an outcome-dependent *response* computed from the shell's outcome flag, not a display-joined
   projection read back inside the engine, and rule 3 has translation happening at the boundary *before* the
   engine sees the batch. Recorded as a project-specific deviation in `docs/write-path.md` (see Consequences),
   not smuggled in as compliance.

5. **The payoff: `transactionApplier` collapses to a registration.** With 1, 3 and 4 landed, nothing
   entity-specific decides anything in it and it becomes
   `versionedTableApplier(transactions, { idempotencyColumn, readBack })`. Its doc comment — which enumerates
   exactly the three reasons this ADR addresses — goes with it.

   **This changes `delete` behavior, and the change is intended.** Today `transactionApplier.delete` has no error
   handling, so deleting a transaction still referenced by `bills.paymentTransactionId` (an FK with no cascade)
   surfaces a raw foreign-key error as a 500. `versionedTableApplier.delete` catches
   `isForeignKeyConstraintViolation` and rethrows `VersionConflict`, so after the collapse the same race becomes
   a bounded retry and then a generic `conflict` — the treatment every other entity already gets, and the
   correct one: a row acquiring a referrer between the flow's read and its apply is the same "world changed"
   condition a stale version reports.

6. **The invariant, and how it is checked.** The rule is *an applier decides nothing and performs no reads at
   all* — sharpened in step 3 from "…reads nothing in order to decide", whose qualifier was unadjudicatable in
   review (any read can be argued "mechanical"; the flat rule needs no argument). The mechanically checkable
   proxy is **an applier writes exactly one table** — grep-able, and it catches both of the original violators.
   The proxy is not the rule: `attachTags` would violate the rule even if its rows lived in the same table,
   because the sin is the read itself, and a hypothetical applier writing a row plus its own audit trail would
   trip the proxy while deciding nothing. The engine's own read — the registered `readBack` hook, fed on a
   duplicate by the engine's surviving-row lookup (decision 4) — is not an applier read: it is generic
   machinery an entity opts into by registration, and the recorded deviation that caps it lives in
   `docs/write-path.md`. Reviewers check the rule; the proxy is what makes a regression visible in a diff.

## Options Considered

### Option A — Leave both appliers as they are (rejected)
The layer boundary is satisfied on paper (the domain doesn't call them) while four domain decisions — merchant
creation, tag-name resolution and its leniency, the learning weight, the edge origin — live in persistence
handlers, untestable from the flows that own them. It also keeps a ~90-line bespoke applier whose stated
justification is entirely made of things this ADR addresses.

### Option B — Move the decisions into the core; generic idempotency; single-table appliers (chosen)
| Dimension | Assessment |
| --- | --- |
| Rule ownership | Every persisted value is chosen in `logic/`/`controllers/`, testable without infrastructure |
| Engine genericity | Idempotency by registration, not a branch; one read-only hook, explicitly capped and recorded as a deviation |
| Simplification | `transactionApplier` collapses; the applier set becomes uniform in behavior, not in construction |
| Invariant | "One table, no decisions" holds for all twelve — a reviewable, grep-able property |
| Cost | A new entity + a link entity; batches grow by one or two `Persistable`s per transaction write; two behavior changes (duplicate-path tags, transaction delete under FK) |

### Option C — Generalize idempotency alone, keep merchants/tags in the applier (rejected)
Pays for the generic mechanism without the payoff: the applier stays bespoke for the other two reasons, so the
collapse that justifies the work never happens. Generic idempotency for a single entity, with the bespoke
applier still standing, is speculative generality.

### Option D — Core builds the full response, no `readBack` hook (rejected for now)
The purest reading of rule 6, and it removes the concession in decision 4 entirely. Rejected because the core
would have to assemble the display-joined view itself — extra reads on every create, in a flow that already has
the data on disk one join away. Named here as the fallback if the hook ever needs a sibling.

## Consequences

- **New entities**: `merchant` (`{ key }`) and `transactionTag` (`{ transactionId, tagIds }` — see decision 3's
  as-built note), each with its own tag constant, model, and single-table applier registered at the composition
  root.
- **`MerchantCategoryEdge` gains `weightDelta`/`origin`**, set by `resolveMerchantCorrection`; the applier reads
  both off the model. `origin` stays insert-only, now by decision.
- **`TransactionEntity.tagNames` is removed** — tag links are a separate `Persistable`, not a field the applier
  interprets. `models/transaction.ts`'s "persistence structure, not a business decision" note is deleted with it,
  as is `models/merchant.ts`'s doc comment hardcoding the same `weight = weight + 1` prose this ADR moves.
- **Tag resolution and its leniency move to `logic/`**, matching against `deps.tags.list()`, with direct tests
  for both the resolved and the dropped case.
- **`versionedTableApplier` gains optional registration config** (`idempotencyColumn`, `readBack`);
  `applyPersistable`'s "the applier's own concern" comment is replaced by the generic path.
- **`transactionApplier` and its `attachTags`/`replaceTags` helpers are deleted.** `fetchTx` stays (it backs
  `transactionsRepo.getById`/`findAllCorrelatedToCard` and the registered `readBack`);
  `fetchTxByIdempotencyKey` is deleted outright — its query became the engine's generic key→surviving-row
  resolution (decision 4), and `readBack` reads by the id the engine hands it, no branch. `readBack` is a
  function, not a SQL fragment.
- **Two behavior changes**, both covered by updated integration tests rather than landing as silent diffs:
  - **Duplicate-insert tag semantics.** Pre-ADR behavior: tags were skipped when an insert no-op'd as a
    duplicate (`if (applied && entity.tagNames.length > 0)`), so the existing row kept the tags it had. Step 2
    shipped the tag set as an unconditional `Persistable` addressed by `idempotencyKey`, which **overwrote** the
    surviving row's tags on a replay — expressing the skip seemed to require an effect conditional on another
    effect's outcome, which `FlowOutcome` cannot express (`persist` is fixed before any outcome exists). Step 3
    restored the original semantic without any conditionality: the set addresses the flow's own minted id,
    which on a duplicate replay simply doesn't exist, so it no-ops mechanically — **a duplicate replay never
    touches the surviving row's tags**, first-write-wins like the rest of the row (decision 3's as-built note).
  - **Transaction delete under a foreign key** (decision 5): raw FK error → bounded retry → generic `conflict`.
- **Batch sizes grow**: a classified transaction write now carries up to three `Persistable`s (merchant,
  transaction, tag set) where it carried one. Same transaction, same round trip; more explicit.
- **Docs**: the applier invariant (and its single-table proxy) is recorded in `docs/architecture.md`'s
  § Write path guardrails; the new entities and the `readBack` deviation from FC/IS rules 3/6 live in
  `docs/write-path.md`. (The full write-path mechanics were later split out of `docs/architecture.md` into
  `docs/write-path.md`; these pointers reflect the current location.)
  `docs/functional-core-imperative-shell.md` needs no change for the *applier-decides-nothing* half — rule 3
  already says handlers "never encode a business process" and that adding an entity is registration — but it
  does not sanction `readBack`, which is why that lands as a recorded project deviation rather than a claim of
  compliance.

## Migration plan (phased — each behind the full gate)

1. **Merchant entity + weight delta (implemented).** `MERCHANT_ENTITY_TAG` + applier; `weightDelta`/`origin` on
   the edge and on both applier paths; both appliers stop writing `merchants`. `merchantCategoryApplier` becomes
   single-table. **Also landed as a prerequisite**: prepending a merchant `Persistable` ahead of a flow's own
   transaction/learning-edge insert (FK order) broke `firstOutcome`/`lastOutcome`'s positional assumption the
   moment the flow's own entity no longer led or trailed the batch predictably — see the trade-off this ADR
   didn't originally scope in "Outcomes are addressed by entity tag" (`docs/write-path.md` § Outcomes and responses).
   Resolved by making `PersistOutcome` carry the `entity` tag of the `Persistable` it came from and replacing
   `firstOutcome`/`lastOutcome` with `logic/persistence.ts`'s `outcomeFor(tag, outcomes)`, addressed by tag
   rather than position — a small, mechanical, behavior-preserving refactor (`models/persistable.ts`,
   `diplomat/db/effects.ts`, and the handful of call sites in `logic/transaction.ts` and
   `controllers/creditCard/transaction.ts`), landed in the same change since step 1 is what needed it and the
   footprint turned out too small to justify a separate PR.
2. **Tag links to the core (implemented).** `transactionTag` entity + set-replace applier; name resolution and
   leniency into `logic/` against `deps.tags.list()`; `tagNames` off `TransactionEntity`; duplicate-path test
   updated for the overwrite semantic. Step 2 addressed the set by `idempotencyKey`; step 3 re-addressed it by
   `transactionId` and restored keep-existing-on-duplicate — decision 3's "As built" note describes the final
   state.
3. **Generic idempotency + the collapse (implemented).** `versionedTableApplier` config; `transactionApplier`
   replaced by a registration; the "applier's own concern" comment removed; the FK-delete behavior change
   covered by a test. This step is what proves 1 and 2 landed — if the applier does not collapse, something is
   still deciding inside it. Landed alongside: the sharpened decision-6 invariant ("no reads at all") and the
   tag set re-addressed by `transactionId` with the duplicate-replay no-op (decision 3's as-built note), which
   removed `transactionTagApplier`'s own `SELECT … WHERE idempotency_key = ?` — the read step 2 had leaned on.

Order matters: 3 last, because its justification *is* the collapse.

## Action Items

1. [x] Review/accept this ADR.
2. [x] Step 1 — merchant entity + weight delta.
3. [x] Step 2 — tag links resolved in the core, overwrite-on-duplicate.
4. [x] Step 3 — generic idempotency; `transactionApplier` collapses to a registration.
5. [x] Record the applier invariant and its single-table proxy in `docs/architecture.md`'s § Write path
   guardrails, and the new entities and `readBack` deviation in `docs/write-path.md`.
