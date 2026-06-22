# Feature Design 004: `aggregate_spending` — the dashboard primitive

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Not started · **Branch:** `feat/aggregate-spending` (suggested) ·
**Date:** 2026-06-21 · Governed by **ADR-011** (safe dynamic aggregation). Opens **Phase 3** (Insights).

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

Phase 3 is insights/analysis. `get_spending_summary` answers one fixed question (income/expense/by-category for a
month). The dashboards and analysis the project is for need a **flexible** read primitive: "group my spending by
X over period Y, filtered by Z, measured as M." That primitive is `aggregate_spending` — the engine that
**saved views** persist parameterizations of, that budget reporting reads, and that `find_correlations` builds
on. Getting it right (and safe) first unlocks the rest of Phase 3.

The one hard part is that the query *structure* (what to group by, which metric) is caller-chosen, which
collides with "all SQL parameterized, never interpolate caller input." **ADR-011** resolves this: structural
choices are zod enums mapped to developer-authored SQL fragments (whitelist), values are parameter-bound, caller
text never reaches the SQL string. This design implements that for spending aggregation.

## Decision

1. **One tool, four knobs.** `aggregate_spending(groupBy, metric?, period, filters?, limit?, sort?)`:
   - **`groupBy`** (`AggregateGroupBy` enum, required): `category | account | tag | month | merchant`.
   - **`metric`** (`AggregateMetric` enum, default `sum`): `sum | count | avg` of `amount`.
   - **`period`**: `month`+`year` **or** `from`/`to` (`YYYY-MM-DD`), same shape as `search_transactions`.
   - **`filters`** (all optional): `account` (name), `category` (name), `type` (`expense | income`),
     `tags` (names).
   - **`limit`** (optional top-N), **`sort`** (`asc | desc`, default `desc` by metric value).
2. **Per-currency, always.** Results are grouped per currency and never mixed/converted (a row's currency is part
   of the grouping). Output is per-currency blocks.
3. **Effective, non-transfer by default.** Only `effective` transactions count; `type = 'transfer'` is excluded —
   consistent with `get_spending_summary` and the balances invariant. (A `status` opt-in can come later; not v1.)
4. **Safe composition (ADR-011).** `diplomat/db` owns whitelist maps `AggregateGroupBy → { expr, join, label }`
   and `AggregateMetric → aggregate`. Only those fragments are composed; every filter value is parameter-bound.
   An unmapped enum is an `assertNever`/compile error.
5. **Locale-resolved labels.** For `groupBy: category`, the row label resolves to the active locale
   (`COALESCE(json_extract(c.names, '$.' || <locale>), c.name)`, ADR-009), with the **server-derived** locale
   bound as a parameter. Other group-bys label by their natural name/key; `month` labels `YYYY-MM`.
6. **Layering (mirrors `get_spending_summary`).** Controller resolves filter *names → ids* (via `resolve.ts`),
   reads the effective locale, and calls the repo; the repo builds the parameterized aggregation and zod-decodes
   rows (`wire/db`); a pure `logic/` function shapes rows into per-currency blocks (sort, total, percent-of-total).
   `get_spending_summary` stays as-is — `aggregate_spending` is the general primitive beside it.
7. **Shared filter layer with `search_transactions` (DRY).** `aggregate` and `search` differ in their *tail*
   (search projects rows + `ORDER BY date LIMIT`; aggregate groups + reduces), but their **`WHERE` is the same**
   (period range, account, type, tags, plus the `effective` + non-transfer guards). Factor a single
   filter-clause builder in `diplomat/db` (a function returning the composed, parameter-bound `WHERE` `SQL`) and
   use it in **both** the `search` and `aggregate` repo methods — do not copy-paste the filter SQL. Filter
   *name → id* resolution already lives in `controllers/resolve.ts` and is shared as-is. This captures the real
   overlap between the two tools without merging them (see Options).

### Output shape (illustrative)

```jsonc
{ "groupBy": "category", "metric": "sum",
  "currencies": [
    { "currency": "BRL", "total": 1850.0,
      "rows": [
        { "key": "cat-food", "label": "Alimentação", "value": 1200.0, "count": 18, "pct": 64.9 },
        { "key": "cat-transport", "label": "Transporte", "value": 650.0, "count": 9, "pct": 35.1 }
      ] } ] }
```

## Scope / out of scope

- **In:** the `aggregate_spending` MCP tool + REST route; `AggregateGroupBy`/`AggregateMetric` enums + IO models;
  the whitelist maps + parameterized aggregation in `diplomat/db` (ADR-011); name→id filter resolution;
  **a shared `WHERE`-clause builder factored out of `search_transactions` and reused** (Decision 7);
  locale-resolved category labels; per-currency, effective, non-transfer aggregation; pure output shaping (sort,
  total, percent); the ADR-011 invariant in `docs/architecture.md`; `docs/mcp-tools.md`.
- **Out:** `save_view`/`list_views` (next Phase 3 feature, builds on this); `find_correlations`; budgets/goals;
  cross-currency conversion (per-currency only; FX still open); group-bys beyond the five (`subCategory`, `type`,
  `day`/`week`, `card` are one-map-line additions later); a `status` filter; charts/rendering (the `chartHint`
  lives with saved views).

## Options Considered

The **safe-composition** decision (whitelist maps vs. string-built columns vs. a query builder) is adjudicated in
**ADR-011** (Option C chosen) and not re-argued here. This design weighs only the surface choices:

### Separate tool vs. a `groupBy` flag on `search_transactions` — **separate tool**
`search` and `aggregate` *look* similar because they share filters, but they are different operations with
different return types: `search` returns **rows** (`TransactionView[]`); `aggregate` returns **reductions**
(grouped `{ key, label, value, count }` per currency). Folding aggregation into `search` via a `groupBy?` flag
makes its return type **polymorphic** (rows when absent, aggregates when present) — a discriminated union the
agent and the type system must branch on. That violates single-responsibility (`docs/code-quality.md`: "one
job; if the description says *and*, split it") and mirrors the existing split (`get_spending_summary` is already
a separate read tool, not a flag on `search`). Two intent-named tools also route better for the MCP agent
("list my restaurant transactions" → search; "how much per category" → aggregate). The genuine overlap — the
filters — is shared at the `WHERE`-builder level (Decision 7), not by merging the tools. **Rejected** the merged
tool; kept them separate with a shared filter layer.

### Output: per-currency blocks — **chosen**
**Pros:** never mixes currencies (the standing invariant); matches `get_spending_summary`'s shape; percent-of-
total is well-defined within a currency.
**Cons:** a multi-currency user gets N blocks (correct, but the caller iterates).

### Alternative: flat rows with a currency column — rejected
**Cons:** invites accidental cross-currency `SUM`s by consumers; percent-of-total ambiguous. The per-currency
block makes the invariant structural.

## Consequences

- **New:** `models/aggregate.ts` (enums + `AggregateSpendingInput`/`AggregateSpendingResult`), a repo method
  `transactions.aggregate(params)` with the ADR-011 whitelist composition, a pure `logic/aggregate.ts` shaper,
  the controller, and the MCP tool + REST route. Mirrors the summary stack.
- **Reuse:** filter name→id resolution via `controllers/resolve.ts`; effective locale via the settings deps;
  `wire/db` decode; the per-currency shaping pattern from `logic/summary.ts`.
- **`find_correlations` and `save_view`** will build directly on this (same enums + the ADR-011 pattern).
- **Invariant added** to `docs/architecture.md` (ADR-011 dynamic-composition rule) + ADR-011 indexed.
- **Blast radius:** additive — new files + two new edges (mcp/http) + one repo method. No change to existing
  tools, balances, or classification.

---

## Implementation prompt

> Hand this to a coding agent. The design above is the source of truth; **read ADR-011 first**
> (`docs/adr/011-safe-dynamic-aggregation.md`). Work on branch **`feat/aggregate-spending`** off `main`;
> `git fetch && git rebase origin/main` first. Read `CLAUDE.md` (esp. the **Definition of Done**),
> `docs/architecture.md` (invariants, dependency table), `docs/code-style.md`, `docs/code-quality.md`. Mirror the
> existing summary stack: `src/controllers/summary.ts`, `src/logic/summary.ts`, the `summaryRows` method in
> `src/diplomat/db/repos/transactions.ts`, and `src/diplomat/mcp/server.ts` (`get_spending_summary`). Also skim
> `src/controllers/resolve.ts`, `src/logic/period.ts`, the settings/locale resolution, and `src/wire/db`.

### Steps

1. **Models** (`models/aggregate.ts`): `AggregateGroupBy = z.enum(['category','account','tag','month','merchant'])`,
   `AggregateMetric = z.enum(['sum','count','avg'])`, plus `AggregateSpendingInput` (groupBy, metric default sum,
   period as month+year OR from/to, optional filters {account, category, type, tags}, optional limit, sort default
   desc) and `AggregateSpendingResult` (per-currency blocks of `{ key, label, value, count, pct }`). Types are
   `z.infer`; use enum members everywhere, never literals.
2. **Whitelist maps + query** (`diplomat/db/repos/transactions.ts`, ADR-011): a `Record<AggregateGroupBy, {expr,
   join, label}>` and `Record<AggregateMetric, SQL>` of developer-authored `sql` fragments. Compose one
   parameterized query: select `expr AS key`, `label`, `currency`, `metric AS value`, `COUNT(*) AS count`; apply
   the group-by's join; `WHERE` the bound period + filters + `status = 'effective'` + `type != 'transfer'`; `GROUP
   BY currency, key`; order by value per `sort`; `LIMIT` per `limit`. **Every value is parameter-bound;** the
   category `label` localizes via the **bound active locale**. Decode rows through `wire/db` zod.
2a. **Shared filter builder** (Decision 7): extract the `WHERE` composition (period range, account, type, tags,
   `effective`, non-transfer) into one helper in `diplomat/db` and call it from **both** the existing `search`
   method and the new `aggregate` method — the two diverge only after the `WHERE`. Refactor `search` to use the
   helper in this change so the filter SQL exists once. (Behavior of `search` is unchanged — cover it with the
   existing tests.)
3. **Pure shaping** (`logic/aggregate.ts`): group decoded rows into per-currency blocks, sort, compute each
   block's `total` and each row's `pct`. Pure, unit-tested, no I/O.
4. **Controller** (`controllers/aggregate.ts`): resolve filter names → ids via `resolve.ts`; read the effective
   locale from settings deps; call `deps.transactions.aggregate(...)`; shape via `logic/aggregate.ts`. `safeTry`,
   returns `ResultAsync`.
5. **Surface:** `aggregate_spending` MCP tool (rich description + `.describe()` on `groupBy`/`metric`/period/
   filters) + REST route, mirroring `get_spending_summary`.

### Tests
- **Unit** (`logic/aggregate.ts`): shaping — per-currency grouping, sort desc/asc, total + pct (incl. empty,
  single-row, and a zero-total guard so pct doesn't divide by zero).
- **Integration** (in-process libSQL): seed a couple accounts/currencies + transactions; assert (a) `groupBy:
  category` sums per currency correctly with locale-resolved labels; (b) a `type`/`account` filter narrows
  results; (c) **transfers excluded** and **pending excluded**; (d) `groupBy: tag` multi-counts a 2-tag
  transaction in both groups; (e) `groupBy: month` over a from/to range returns a time series; (f) `limit`
  returns top-N by value; (g) an invalid `groupBy` is rejected at the boundary (zod) — proving no caller text
  reaches SQL.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **ADR-011:** dynamic structure only from whitelisted enum-keyed fragments; all values parameter-bound; caller
  text never concatenated into SQL. Exhaustive maps (`assertNever`).
- **Per-currency, effective, non-transfer** aggregation by default (matches `get_spending_summary` + balances).
- **Locale-resolved category labels** via the server-derived locale (ADR-009).
- **Diplomatic layering:** enums/IO in `models/`; whitelist + SQL in `diplomat/db`; pure shaping in `logic/`;
  orchestration + name→id resolution in the controller; thin diplomats; constants over literals.
- **Docs in the same change:** `docs/architecture.md` (the ADR-011 dynamic-composition invariant + ADR-011 in
  the index), `docs/mcp-tools.md` (`aggregate_spending` schema, errors, example).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push; this is **feature-sized** (a new
  tool + dynamic SQL), so also run the independent verification pass — with extra scrutiny on the ADR-011 safety
  boundary.

### Finish
Conventional Commits (`feat(insights): aggregate_spending dashboard primitive` + `test:`/`docs:`),
`git push -u origin feat/aggregate-spending`, open a PR targeting `main`. Run the Definition of Done; do not
merge; after CI, reply to review threads with the resolving SHA.
