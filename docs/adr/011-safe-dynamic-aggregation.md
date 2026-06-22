# ADR-011: Safe composition of dynamic aggregation queries

**Status:** Accepted · **Date:** 2026-06-21 · Builds on the parameterized-SQL invariant in
`docs/architecture.md`. Governs Phase 3 analysis tools (`aggregate_spending`, `find_correlations`). First
realized by Feature Design 004.

## Context

Phase 3's analysis tools need **dynamic** queries: `aggregate_spending` lets the caller choose what to group by
(category / account / tag / month / merchant), which metric to compute (sum / count / avg), and which filters
to apply. Unlike every query so far, the *structure* of the SQL — the `SELECT` expression, the `GROUP BY`
column, the joins — varies with caller input.

This collides with a hard project invariant: **all SQL is parameterized; never interpolate client input**
(`docs/architecture.md`, `CLAUDE.md`). Parameter binding (`?`) covers **values** (a category id, a date), but
it cannot bind **identifiers or expressions** — you can't `GROUP BY ?`. So a naive dynamic query would be
tempted to string-build the column name from caller input, which is exactly SQL injection.

We need a rule that keeps structural dynamism without ever letting caller text reach the SQL string.

## Decision

**Dynamic SQL structure comes only from whitelisted, code-owned fragments selected by a validated enum;
dynamic values are always parameter-bound. Caller text never becomes SQL text.**

1. **Enums at the boundary.** Every structural choice is a zod enum in `models/` (`AggregateGroupBy`,
   `AggregateMetric`, …). The boundary rejects anything not in the enum before it reaches the domain.
2. **Whitelist maps own the SQL.** A constant map in `diplomat/db` translates each enum member to a fixed,
   developer-authored SQL fragment (the column/expression + any join it needs). The map is the *only* source of
   structural SQL; it is keyed by the enum, so an unmapped key is a compile-time/`assertNever` error, not a
   runtime string.

   ```ts
   // diplomat/db — illustrative, not literal
   const GROUP_BY: Record<AggregateGroupBy, { expr: SQL; join: SQL; label: SQL }> = {
     category: { expr: sql`t.category_id`, join: sql`LEFT JOIN categories c ON c.id = t.category_id`, label: sql`c.name` },
     month:    { expr: sql`substr(t.date, 1, 7)`, join: sql``, label: sql`substr(t.date, 1, 7)` },
     // account | tag | merchant …
   }
   const METRIC: Record<AggregateMetric, SQL> = {
     sum: sql`SUM(t.amount)`, count: sql`COUNT(*)`, avg: sql`AVG(t.amount)`,
   }
   ```
3. **Values stay bound.** Every filter value (account id, date range, type, tag names) is interpolated through
   Drizzle's `sql` tag as a **parameter**, exactly as today. Only the whitelisted fragments are composed as SQL.
4. **Decode the result at the boundary.** Aggregation rows are zod-parsed (`wire/db`) before entering the
   domain, like every other row.
5. **Per-currency, effective, non-transfer by default.** Aggregations group per currency (never mix), count only
   `effective` transactions, and exclude `type = 'transfer'` — consistent with `get_spending_summary` and the
   balances invariant. Deviations are explicit opt-ins, never defaults.

## Options Considered

### Option A — Build the column/expression string from caller input
**Pros:** trivial.
**Cons:** SQL injection; violates the parameterized-SQL invariant outright. Rejected unconditionally.

### Option B — A query builder / ORM relation layer for dynamic grouping
**Pros:** handles composition.
**Cons:** the project deliberately uses hand-written parameterized SQL (ADR-006 + risks section of PLAN); a
general builder is more surface than a fixed, small whitelist needs, and still requires the same enum→fragment
discipline to be safe. Over-engineered for five group-bys.

### Option C — Whitelisted enum→fragment maps + parameter binding — **chosen**
| Dimension | Assessment |
|---|---|
| Injection safety | Structural SQL is developer-authored only; values bound. Safe by construction |
| Fit | Matches the existing hand-written-SQL, decode-at-boundary style |
| Extensibility | Add a group-by/metric = add one map entry (+ its zod enum member) |
| Cost | A small map per tool; `assertNever` guarantees exhaustiveness |

**Pros:** safe by construction; minimal; reuses the established SQL style; trivially extensible; exhaustiveness
checked by the type system.
**Cons:** every new dimension is a deliberate code change (a feature, not a free-form query) — which is the
point.

## Trade-off Analysis

The tension is **caller flexibility vs. injection safety.** Option A maximizes flexibility and is unsafe.
Option C constrains the caller to a curated set of dimensions/metrics but makes injection structurally
impossible and keeps the curation cheap (one map line per dimension). For a finance tool where the query
surface is small and well-known, trading "arbitrary grouping" for "provably safe grouping" is clearly right —
and the enum-keyed map means adding a dimension stays a one-line, reviewed change.

## Consequences

- **`models/`** gains the aggregation enums (`AggregateGroupBy`, `AggregateMetric`, …) as the boundary contract.
- **`diplomat/db`** owns the whitelist maps and composes the parameterized query; the controller resolves filter
  *names → ids* and calls the repo; pure output shaping (sort, percent-of-total) lives in `logic/`.
- **Reused by `find_correlations`** and any future analysis tool — same enum→fragment + parameter-binding rule.
- **Shared filter `WHERE`-builder.** The parameter-bound filter clauses (period, account, type, tags, the
  `effective` + non-transfer guards) are common to row queries (`search_transactions`) and aggregation queries.
  Factor them into one `diplomat/db` helper used by both; only the projection-vs-grouping tail differs. Sharing
  the filter layer is the right de-duplication — not merging the list and aggregate tools (different return
  types; see Feature Design 004).
- **Invariant (added to `docs/architecture.md`):** *dynamic query structure is composed only from whitelisted
  enum-keyed SQL fragments; caller-supplied values are always parameter-bound; caller text is never concatenated
  into SQL.*

## Action Items

1. [ ] Add the aggregation enums to `models/`.
2. [ ] Implement the whitelist maps + parameterized composition in `diplomat/db` (Design 004).
3. [ ] Add the invariant to `docs/architecture.md` and index this ADR.
