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
   Note (post ADR-010): `credit` accounts are real accounts now, so `groupBy: account` naturally surfaces them —
   card purchases post to the card's account and show up there; bill payments are transfers and are already
   excluded, so there's no double-counting.
4. **Safe composition (ADR-011).** `diplomat/db` owns whitelist maps `AggregateGroupBy → { expr, join, label }`
   and `AggregateMetric → aggregate`. Only those fragments are composed; every filter value is parameter-bound.
   An unmapped enum is an `assertNever`/compile error.
5. **Locale-resolved labels — via the existing shared TS resolver.** For `groupBy: category`, the row label
   resolves to the active locale via **`logic/category.ts#localizeCategoryName(name, names, locale)`** — the same
   helper `summaryRows`/`summarize` and `fullTxSelect`/`dbToModel` already use (`names?.[locale] ?? name`). Follow
   that codebase pattern: the SQL selects the category `name` **and** its `names` JSON (exactly like
   `summaryRows` does: `c.name AS …, c.names AS …`), and the **pure `logic/` shaping** resolves the display label
   with `localizeCategoryName` — **resolution happens in TS, not in SQL** (do *not* `json_extract` in the query;
   the codebase resolves category names in TS, one mechanism). Never surface raw `c.name`. This rule has leaked
   one query at a time as separate bug fixes; `aggregate_spending` must not repeat it. Other group-bys label by
   their natural name/key; `month` labels `YYYY-MM`.
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

8. **Follow the current baseline conventions (post-sweep).** The whole model/wire layer was standardized after
   this design was first written; `aggregate_spending` must be built to that baseline, not the old one:
   - **Naming:** object/input schemas use the `Schema` suffix with a bare inferred type (`AggregateSpendingSchema`
     + `type AggregateSpending`; result `AggregateResultSchema` + `type AggregateResult`), and **no `Input`
     suffix**. The `AggregateGroupBy` / `AggregateMetric` **enums stay bare**.
   - **Input contract = zod-in-model + `infer`:** define the input zod once in `models/aggregate.ts`; `wire/in`
     derives it. No hand-written input interfaces.
   - **`.describe()` is domain info → on the model fields;** the MCP tool derives its `inputSchema` from
     `AggregateSpendingSchema.shape` (do not re-author describes at the edge).
   - **Defaults by intent:** quality-of-life defaults (`metric → sum`, `sort → desc`, the top-N `limit` default)
     live at the **wire boundary**; the domain stays strict.
   - **Value objects** come from the split modules: `PeriodSchema`/`IsoDate` from `models/date.ts`,
     `CurrencyCode` from `models/money.ts` (the old `models/common.ts` is gone).
   - **REST period coercion** reuses `coerceToNumber` (`wire/in/coerce.ts`) via
     `z.preprocess(coerceToNumber, PeriodSchema.shape.month/year)` — same pattern as `wire/in/bills.ts`; this is
     also the moment to extract the still-inline coerced-period schema out of the summary route into `wire/in`
     and share it.
   - **Errors (ADR-012):** the only expected failures are name→id resolution (`NotFound<'account'|'category'>`,
     already owned by those models via `resolve.ts`) and an invalid period → use the shared `ValidationError`
     primitive (`models/error.ts`, `validation([...])`). No new god-union entry; only add an `AggregateError`
     union (composed into `AppError`) if an aggregate-specific code actually emerges (none expected for v1).

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

- **New:** `models/aggregate.ts` (bare enums + `AggregateSpendingSchema`/`AggregateResultSchema` with describes),
  `wire/in/aggregate.ts` (derives the input + QoL defaults + coerced period), a repo method
  `transactions.aggregate(params)` with the ADR-011 whitelist composition, a pure `logic/aggregate.ts` shaper,
  the controller, and the MCP tool (inputSchema derived from `.shape`) + REST route. Mirrors the summary stack on
  the current baseline.
- **Reuse:** filter name→id resolution via `controllers/resolve.ts`; effective locale via the settings deps;
  `wire/db` decode; `coerceToNumber` (`wire/in/coerce.ts`) + `PeriodSchema` (`models/date.ts`) for period parsing;
  `ValidationError`/`validation` (`models/error.ts`); the per-currency shaping pattern from `logic/summary.ts`.
- **Cleanup folded in:** extract the inline coerced-period schema from the `/api/summary` route into `wire/in`
  (the previously-deferred summary-coercion follow-up), shared by summary + aggregate.
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
> `src/diplomat/db/repos/transactions.ts`, and `src/diplomat/mcp/server.ts` (`get_spending_summary`). For the
> category-label resolution pattern (select `c.name` + `c.names`, resolve in TS), study `summaryRows` +
> `summarize` and `src/logic/category.ts` (`localizeCategoryName`) — the same path `fullTxSelect`/`dbToModel`
> uses. **For the current model/wire/MCP conventions, mirror a recently-converted domain end-to-end** — read
> `src/models/bill.ts` + `src/wire/in/bills.ts` (Schema-suffix, zod-in-model, wire-derives, REST coercion via
> `coerceToNumber`) and how a tool derives `inputSchema` from `XxxSchema.shape` in `server.ts`. Also skim
> `src/models/date.ts` (`PeriodSchema`, `IsoDate`), `src/models/money.ts` (`CurrencyCode`), `src/models/error.ts`
> (`ValidationError`, `validation`), `src/wire/in/coerce.ts`, the `search` method + its `conditions`/`where` in
> `src/diplomat/db/repos/transactions.ts` (Decision 7), `src/controllers/resolve.ts`, `src/logic/period.ts`, the
> settings/locale resolution, and `src/wire/db`. (`models/common.ts` no longer exists — value objects live in
> `date`/`money`/`id`.)

### Steps

1. **Models** (`models/aggregate.ts`, current conventions — see Decision 8): bare enums
   `AggregateGroupBy = z.enum(['category','account','tag','month','merchant'])` and
   `AggregateMetric = z.enum(['sum','count','avg'])`. Input as a zod schema in the model with the `Schema` suffix
   and a bare inferred type: `AggregateSpendingSchema` (groupBy; metric; period = month+year OR from/to using
   `PeriodSchema`/`IsoDate` from `models/date.ts`; optional filters {account, category, type (`MovementType`),
   tags}; optional `limit`; `sort`) + `type AggregateSpending = z.infer<…>`. Result as
   `AggregateResultSchema` (per-currency blocks of `{ key, label, value, count, pct }`) + `type AggregateResult`.
   Put `.describe()` on the fields (domain info). Keep the domain strict — do NOT bake the metric/sort/limit
   convenience defaults here (those go on the wire schema, step 1b). `CurrencyCode` from `models/money.ts`. Use
   enum members everywhere, never literals.
1b. **Wire** (`wire/in/aggregate.ts`): derive from `AggregateSpendingSchema`; add the quality-of-life defaults
   here (`metric → sum`, `sort → desc`, the top-N `limit` default) and the REST period coercion via
   `z.preprocess(coerceToNumber, PeriodSchema.shape.month/year)` (reuse `wire/in/coerce.ts`, mirroring
   `wire/in/bills.ts`). While here, extract the still-inline coerced-period schema out of the `/api/summary`
   route into `wire/in` and share it (the deferred summary-coercion cleanup).
2. **Whitelist maps + query** (`diplomat/db/repos/transactions.ts`, ADR-011): a `Record<AggregateGroupBy, {expr,
   join, label}>` and `Record<AggregateMetric, SQL>` of developer-authored `sql` fragments. Compose one
   parameterized query: select `expr AS key`, the label column(s), `currency`, `metric AS value`, `COUNT(*) AS
   count`; apply the group-by's join; `WHERE` the bound period + filters + `status = 'effective'` + `type !=
   'transfer'`; `GROUP BY currency, key`; order by value per `sort`; `LIMIT` per `limit`. **Every value is
   parameter-bound.** For `groupBy: category`, select **both** `c.name` and the `c.names` JSON (mirror
   `summaryRows`' `c.name AS …, c.names AS …`) and resolve the display label **in the pure `logic/aggregate`
   shaping** via `logic/category.ts#localizeCategoryName(name, names, locale)` — the codebase resolves category
   names in TS, not SQL; do **not** `json_extract` in the query, and never surface raw `c.name`. Decode rows
   through `wire/db` zod (the raw `name` + `names` ride on the decoded row; the resolved `label` is produced in
   shaping).
2a. **Shared filter builder** (Decision 7): extract the `WHERE` composition (period range, account, type, tags,
   `effective`, non-transfer) into one helper in `diplomat/db` and call it from **both** the existing `search`
   method and the new `aggregate` method — the two diverge only after the `WHERE`. Refactor `search` to use the
   helper in this change so the filter SQL exists once. (Behavior of `search` is unchanged — cover it with the
   existing tests.)
3. **Pure shaping** (`logic/aggregate.ts`): group decoded rows into per-currency blocks, sort, compute each
   block's `total` and each row's `pct`. Pure, unit-tested, no I/O.
4. **Controller** (`controllers/aggregate.ts`): resolve filter names → ids via `resolve.ts` (its `NotFound`
   errors are already owned by account/category); validate the period (neither month/year nor from/to →
   `validation([...])` from `models/error.ts`); read the effective locale from settings deps; call
   `deps.transactions.aggregate(...)`; shape via `logic/aggregate.ts`. `safeTry`, returns
   `ResultAsync<AggregateResult, AppError>` (no new error union needed — reuses resolve errors + `ValidationError`).
5. **Surface:** `aggregate_spending` MCP tool — derive `inputSchema` from the wire `AggregateSpendingSchema.shape`
   (descriptions come from the domain; do not re-author them inline) + a rich tool-level `description`. REST route
   parses the wire schema (coerced period). Mirror `get_spending_summary`.

### Tests
- **Unit** (`logic/aggregate.ts`): shaping — per-currency grouping, sort desc/asc, total + pct (incl. empty,
  single-row, and a zero-total guard so pct doesn't divide by zero).
- **Integration** (in-process libSQL): seed a couple accounts/currencies + transactions; assert (a) `groupBy:
  category` sums per currency correctly with locale-resolved labels; (b) a `type`/`account` filter narrows
  results; (c) **transfers excluded** and **pending excluded**; (d) `groupBy: tag` multi-counts a 2-tag
  transaction in both groups; (e) `groupBy: month` over a from/to range returns a time series; (f) `limit`
  returns top-N by value; (g) an invalid `groupBy` is rejected at the boundary (zod) — proving no caller text
  reaches SQL; (h) **locale**: after `set_locale('pt')`, `groupBy: category` labels are the pt category names
  (en → English; missing translation → canonical fallback) — same resolution as `search_transactions` /
  `get_spending_summary`.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **ADR-011:** dynamic structure only from whitelisted enum-keyed fragments; all values parameter-bound; caller
  text never concatenated into SQL. Exhaustive maps (`assertNever`).
- **Per-currency, effective, non-transfer** aggregation by default (matches `get_spending_summary` + balances).
- **Locale-resolved category labels** via the shared helper `logic/category.ts#localizeCategoryName` resolved in
  TS (same path as `fullTxSelect`/`dbToModel` and `summaryRows`/`summarize`), server-derived locale (ADR-009) —
  select raw `c.name` + `c.names`, never `json_extract` in SQL, never surface raw `c.name`.
- **Diplomatic layering:** enums/IO in `models/`; whitelist + SQL in `diplomat/db`; pure shaping in `logic/`;
  orchestration + name→id resolution in the controller; thin diplomats; constants over literals.
- **Current conventions (Decision 8):** `Schema`-suffix value + bare inferred type (no `Input` suffix); bare
  enums; input zod lives in `models/` and `wire/in` derives it; `.describe()` on the model fields with the MCP
  `inputSchema` derived from `.shape`; QoL defaults (metric/sort/limit) + REST period coercion at the wire
  boundary; value objects from `models/date|money|id`; expected errors reuse `resolve.ts` + the shared
  `ValidationError` (no new god-union entry).
- **Docs in the same change:** `docs/architecture.md` (the ADR-011 dynamic-composition invariant + ADR-011 in
  the index), `docs/mcp-tools.md` (`aggregate_spending` schema, errors, example).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push; this is **feature-sized** (a new
  tool + dynamic SQL), so also run the independent verification pass — with extra scrutiny on the ADR-011 safety
  boundary.

### Finish
Conventional Commits (`feat(insights): aggregate_spending dashboard primitive` + `test:`/`docs:`),
`git push -u origin feat/aggregate-spending`, open a PR targeting `main`. Run the Definition of Done; do not
merge; after CI, reply to review threads with the resolving SHA.
