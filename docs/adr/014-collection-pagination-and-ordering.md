# ADR-014: Cursor pagination + whitelisted ordering for collection endpoints

**Status:** Proposed · **Date:** 2026-07-04 · **Deciders:** Rafael · Extends the safe-composition invariant of
**ADR-011** to ordering, and unblocks the ADR-013 dashboards (REST is their data layer). Sequenced **before**
ADR-015 (multi-write unit-of-work): this is contract work the UI needs today; the write-path migration follows.

## Context

Dashboard building against the REST API keeps hitting the collection ceiling: `search_transactions` returns at
most `limit` rows (wire default 50, cap 200) with **no way to continue** — there is no cursor, no page, no
envelope. The repo already orders deterministically (`ORDER BY t.date DESC, t.id`) but the contract gives a
client no handle to ask for "the next 50 after these." A month with 300+ transactions is simply not fully
retrievable, and the LLM-generated UIs (ADR-013) have no "load more" they can implement.

Ordering has the mirror gap: the sort is hard-coded (date desc). Letting a caller choose a sort must NOT become
string-concatenated `ORDER BY` — ADR-011 already settled that structural SQL comes only from whitelisted
enum-keyed fragments with values parameter-bound.

Scope note — **grouping is deliberately excluded**: grouped/reduced views are `aggregate_spending`'s job
(ADR-011 / Design 004). This ADR covers row-returning collections only; a second grouping mechanism would
duplicate that tool.

## Decision

**Collection endpoints that can grow unbounded adopt keyset (cursor) pagination with a paginated envelope and
whitelisted, enum-driven ordering. Small fixed collections stay plain arrays.**

1. **Keyset cursor, not offset.** Requests take optional `cursor` (opaque string) + `limit` (existing bounds:
   default 50, cap 200 — now *per page*). The server pages by a **stable composite key** — for transactions the
   already-used `(date, id)` — with a parameter-bound keyset predicate (illustrative, desc):

   ```sql
   -- the keyset predicate MUST be consistent with the chosen ORDER BY, per key component
   -- (each component's comparator matches that component's direction — mixed directions are
   -- fine when matched), or rows sharing a date page incorrectly. Today's query orders
   -- `t.date DESC, t.id` (tiebreaker implicitly ASC); the first mover makes the tiebreaker
   -- direction explicit and the predicate match it. Illustrative, both components desc:
   WHERE ... AND (t.date < ? OR (t.date = ? AND t.id < ?))
   ORDER BY t.date DESC, t.id DESC
   LIMIT ? + 1   -- fetch one extra row to know whether a next page exists (no COUNT query)
   ```

2. **Paginated envelope** on paginated endpoints only:

   ```jsonc
   { "items": [ ... ], "nextCursor": "..." }   // nextCursor absent on the last page
   ```

   `list_accounts`, `list_categories`, `list_tags`, `list_credit_cards`, `list_recurring`, `get_bill` items
   (bounded per cycle) stay **plain arrays** — the envelope is the signal that a collection can page. Future
   unbounded collections adopt the envelope from day one.

3. **Opt-in total count.** Requests accept `includeTotal?: boolean` (default false). When true, the response
   adds `total` — the count of **all items matching the filters** (not pages; a client derives
   `ceil(total / limit)` if it wants page math):

   ```jsonc
   // includeTotal: true →
   { "items": [ ... ], "nextCursor": "...", "total": 312 }
   ```

   Opt-in because it costs an extra `COUNT(*)` with the same WHERE per request: a UI asks once on the first
   page (counters, progress), while agent "walk until no `nextCursor`" loops never pay it. Note the limit of
   the model: `total` enables *display* of page counts, but keyset still has no jump-to-page-N — clients
   navigate by cursor only.

4. **Cursor is opaque, validated, and sort-bound.** Encoding: base64url JSON `{ v, sort, dir, key }` (e.g.
   `key = { date, id }`). Clients treat it as a token. The boundary decodes + zod-validates it like any external
   input; the key values are **parameter-bound** (never concatenated); a malformed/stale cursor or a cursor
   whose `sort`/`dir` doesn't match the request's is a `validation` error (the keyset only makes sense for the
   ordering that produced it). No encryption — local single-user app; opacity is a contract convention, not a
   security boundary.

5. **Ordering rides ADR-011's rails.** Per-endpoint sort is a bare zod enum in the entity's model (e.g.
   `TransactionSortField = z.enum(['date', 'amount'])`) plus a shared `SortDirection = z.enum(['asc','desc'])`;
   `diplomat/db` owns the exhaustive `Record<SortField, SQL>` fragment map (`assertNever` on unmapped keys).
   Caller text never reaches `ORDER BY`. Every ordering appends the entity id as the deterministic tiebreaker —
   which is exactly what makes the keyset stable.

6. **Shared primitives in `models/page.ts`** (the `date.ts`/`money.ts`/`id.ts` convention — a named home, not a
   catch-all): the cursor/limit/`includeTotal` request fields, `SortDirection`, and a `pageSchema(itemSchema)`
   helper producing the `{ items, nextCursor?, total? }` envelope schema. Per-entity sort enums stay on their
   entity's model. QoL default (`limit → 50`) stays at the wire boundary, per the defaults-by-intent rule.

7. **MCP + REST parity, contract surfaced.** Same wire schemas on both edges (MCP tools return the same
   envelope); the OpenAPI document picks the change up from the schemas (parity test stays green); the dashboard
   **template and UI-building skill** are updated in the same change to consume `nextCursor` ("load more" /
   fetch-all loops) so ADR-013's exemplars never hardcode the old array shape.

## Options Considered

### Option A — Offset/limit (`page`/`offset` + `limit`)
| Dimension | Assessment |
| --- | --- |
| Simplicity | Highest; supports page numbers / jump-to-page |
| Stability | **Unstable** — inserts between pages skip/duplicate rows (real here: three concurrent write surfaces) |
| Performance | `OFFSET n` scans n rows in SQLite; degrades with history size |

**Rejected.** The instability bites exactly the dashboard/agent "walk the collection" use case.

### Option B — Keyset cursor + envelope + whitelisted ordering + opt-in total — **chosen (proposed)**
| Dimension | Assessment |
| --- | --- |
| Stability | Stable under concurrent inserts (pages by key, not position) |
| Performance | Indexed seek per page; `LIMIT n+1` avoids COUNT queries; `total` only when asked |
| Fit | Reuses the existing `(date, id)` ordering; ordering whitelist is ADR-011's exact mechanism |
| Cost | No random page jumps (acceptable: agents/dashboards consume sequentially); envelope is a breaking response-shape change for the endpoints that adopt it |

### Option C — Both cursor and offset
**Rejected.** Two code paths, two sets of edge cases, permanent documentation burden — for a page-jump feature
no current consumer needs. Revisit only if a real page-number UI appears.

## Trade-off Analysis

The tension is **contract simplicity vs. correctness under growth and concurrency**. Offset is simpler today
but silently wrong tomorrow (skipped rows during concurrent writes, slow deep pages) — and "silently wrong
numbers" is the one failure mode this project treats as unacceptable. Keyset costs an opaque token and
forfeits page jumps, but pages are stable, seeks stay indexed, and the mechanism composes with what already
exists: the deterministic `(date, id)` ordering becomes the cursor key, and the sort whitelist is ADR-011's
enum→fragment map applied to `ORDER BY`. The opt-in `total` recovers the one thing UIs genuinely miss from
offset pagination (counters/progress) without taxing sequential consumers. Scoping the envelope to paginated
endpoints keeps the breaking change small (one endpoint today) while making "can this collection page?"
legible from the response shape.

## Consequences

- **Breaking (contained):** `search_transactions` responses change from `TransactionView[]` to
  `{ items, nextCursor?, total? }` on both MCP and REST. Updated in the same change: MCP tool description,
  `docs/mcp-tools.md`, OpenAPI (schema-derived), the seeded dashboard template, and the UI-building skill.
- **New:** `models/page.ts` primitives (cursor/limit/`includeTotal`, `SortDirection`, `pageSchema`); per-entity
  sort enums; keyset predicate + `ORDER BY` fragment map + optional same-WHERE `COUNT(*)` in `diplomat/db`;
  cursor encode/decode at the boundary (`wire/`).
- **Unchanged:** small `list_*` endpoints; `aggregate_spending` (grouping stays there; its `limit` is a top-N,
  not a page); per-page bounds (default 50 / cap 200).
- **Invariant (added to `docs/architecture.md` on acceptance):** *unbounded collections page by keyset cursor
  with the paginated envelope; `ORDER BY` is composed only from whitelisted enum-keyed fragments; cursors are
  opaque, validated at the boundary, and bound to the ordering that produced them; `total` is opt-in.*
- Sequencing: this contract work lands **before** the ADR-015 (unit-of-work) migration PRs — it unblocks the UI
  today and the two efforts touch different layers (wire/contract vs repo write paths).

## Action Items

1. [ ] Review/accept this ADR.
2. [ ] Implement first mover: `search_transactions` (models/page.ts + sort enum + keyset repo + envelope +
   `includeTotal` + template/skill updates + docs/OpenAPI) — one PR.
3. [ ] On acceptance: add the invariant to `docs/architecture.md` and index this ADR.
4. [ ] Future unbounded collections (e.g. a transactions-per-bill listing if it ever unbounds) adopt the same
   contract from day one.
