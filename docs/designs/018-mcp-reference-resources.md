# Feature Design 018: MCP reference resources — categories, accounts, top merchants

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Done · **Date:** 2026-07-25 · PLAN Phase 3 (MCP resources). **Read-only** —
exposes existing reference/taxonomy data as MCP resources; no entity, no write flow. Mirrors the existing
`fintrack://openapi` resource registration.

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`. **One PR**:
> `feat/mcp-reference-resources`.

## Context

An agent resolving natural-language input ("R$32 uber ontem", "move it to Alimentação") needs the user's
*vocabulary* — which categories, accounts, and merchants exist — to resolve names and classify. Today it gets
that only by calling `list_categories`/`list_accounts` tools (a round-trip per turn). MCP **resources** expose
that reference data so a client can read it directly, without a tool call — the same mechanism FinTrack already
uses for `fintrack://openapi` (`server.registerResource(name, uri, meta, handler)`, static URI, JSON contents).

PLAN scopes three: `fintrack://categories`, `fintrack://accounts`, `fintrack://merchants/top`.

## Decision

Register five read-only resources — the three below required by PLAN, plus `fintrack://tags` and
`fintrack://credit-cards` (§ "Also trivially available") — reusing existing read paths where they exist and
adding one new query.

1. **`fintrack://categories`** — top-level categories with their display name (locale-resolved, ADR-009) and
   `kind` (expense/income/both). Reuses `listCategories` (`controllers/categories.ts`) — same data
   `list_categories` returns (top-level only; sub-categories are their own tool/resource-shaped data, not
   included here), so the resource and the tool never disagree.
2. **`fintrack://accounts`** — accounts with `name`, `type`, `currency`. Reuses `listAccounts`.
3. **`fintrack://merchants/top`** — the user's most-transacted merchants with their dominant category, so the
   agent recognises recurring vocabulary ("iFood → Alimentação"). **Needs one new read query**
   (`MerchantsRepo.top(limit)` — today the repo has only `matchCandidates`): group **effective, non-transfer**
   transactions by `merchant_key`, count them, resolve each merchant's most-frequent category, order by count
   desc, `LIMIT` (default **20**, a named constant). Returns `[{ merchant, transactionCount, categoryName }]` —
   a reference list, not a money report, so **no per-currency amounts** (keeps it a flat vocabulary list, avoids
   the per-currency grouping a spend total would force).

**Shape & mechanics:** static URIs (no params), `mimeType: application/json`, `contents: [{ uri, mimeType, text:
JSON }]` — the `fintrack://openapi` pattern. Handlers are thin: call the controller/query, serialize. Locale
flows through `listCategories` already (localized display names).

**Also trivially available, and included:** `fintrack://tags` and `fintrack://credit-cards` — both have `list`
queries and are transaction vocabulary too; near-zero cost, same pattern. The PLAN's three above are the
required core; these two round it out to the five actually registered.

## Options / decisions

- **Reuse list controllers (chosen)** — resources return exactly what the tools do; no second read path to drift.
- **`merchants/top` by transaction frequency (chosen)** vs by learned `merchant_category.weight` — frequency is
  the truer "merchants you actually deal with"; weight is the classifier's strength, a different question.
  (Frequency chosen; note the alternative.)
- **Static URIs + default limit (chosen)** vs a `ResourceTemplate` with a `limit` parameter — static is simpler
  and a reference list doesn't need tuning; a template can be added later if a caller wants a bigger list.
- **No per-currency amounts in `merchants/top` (chosen)** — it's vocabulary, not a spend report; a money total
  would drag in per-currency grouping for no reference value.

## Docs to update

- `docs/mcp-tools.md` (or `docs/mcp-clients.md`) — the five resources: URIs, shapes, when an agent should read
  them.
- `docs/architecture.md` — a line noting the reference resources reuse the list read paths (read-only).
- `docs/PLAN.md` — Phase 3 MCP-resources progress.

## Testing

- Each resource returns the expected JSON shape and matches its tool counterpart (`fintrack://categories` ≡
  `list_categories`, `fintrack://accounts` ≡ `list_accounts`).
- `merchants/top`: ordered by transaction count desc, respects the limit, dominant category correct, excludes
  transfers, effective-only; a merchant with no category resolves gracefully.
- Locale: `fintrack://categories` display names honour the resolved locale.

## Implementation prompt

One PR, behind the full gate. Mirror the `fintrack://openapi` `registerResource` call in
`src/diplomat/mcp/server.ts`.

- Register `fintrack://categories` (reuse `listCategories`), `fintrack://accounts` (reuse `listAccounts`), and
  recommended `fintrack://tags` / `fintrack://credit-cards` (reuse their `list`s).
- Add `MerchantsRepo.top(limit)` (the frequency + dominant-category query) + a `topMerchants` read controller +
  the `fintrack://merchants/top` resource.
- Each handler serializes to JSON `contents`; static URIs; `application/json`.
- Docs (`docs/mcp-tools.md`, `docs/architecture.md`), PLAN progress.

### Finish (every push)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing.
