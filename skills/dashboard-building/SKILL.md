---
name: dashboard-building
description: Use when the user asks to build, change, extend, or "show me" a dashboard/UI for their FinTrack finances. Guides generating a data-less HTML fragment that fetches live data from the FinTrack API and saving it with save_dashboard.
---

# Building a FinTrack dashboard

FinTrack dashboards are data-less content **fragments** stored server-side and rendered live inside a shared
app shell at `GET /ui/:name` (ADR-013, fragment model ADR-027). A fragment is `<section>`s + one inline
`<script>` — no `<!doctype>`, `<html>`, `<head>`, or `<style>` root: the shell (`ui/shell.html` +
`ui/app.css` + `ui/app.js`, served by the same FinTrack HTTP server) already provides the document, shared
styling, the menu, and Chart.js. The non-negotiable rule behind everything below: **a dashboard never
contains data — it fetches it.** The fragment you write is layout, styling, and `fetch()` calls; every
number, name, or row the user sees comes from a same-origin `/api` response read after the fragment loads,
every time it loads.

`save_dashboard` only rejects content that can't render as a fragment at all (empty content, a full
`<!doctype>`/`<html>` document root still present, or a `<script>` syntax error) — it does **not** check for
embedded data. Following this checklist is what keeps the dashboard data-less; the save endpoint won't catch
a violation for you.

## Process

1. **Read the API contract first — never guess a path or field name.**
   - MCP: read the `fintrack://openapi` resource.
   - REST: `GET /api/openapi.json`.
   This is the source of truth for available routes, query params, and response shapes, including the
   localized labels (`typeLabel`, `categoryName`, `periodLabel`, `accountName`, …) the API already resolves
   for the user's locale.
   - **`search_transactions` / `GET /api/transactions` is paginated**: it returns a page
     `{ items, nextCursor?, total? }`, not a bare array. Read `items` for the rows; if you need every
     matching transaction (not just a preview slice), loop: pass the previous response's `nextCursor` back
     as the next request's `cursor` and stop when `nextCursor` is absent. `sort`/`dir` must stay the same
     across that loop — they're bound to the cursor, and changing them mid-walk is rejected. Only ask for
     `includeTotal: true` on the first call if you need the total count (e.g. for a "N transactions" label);
     it costs an extra query and every other page already omits it. Other list endpoints (`list_accounts`,
     `list_categories`, `list_tags`, `list_credit_cards`, `list_recurring`, a bill's `transactions`) are plain
     arrays — the envelope is specifically the signal that a collection can page.
2. **Discover the user's perspective — ask in personal-finance terms, not layout terms.** Different users
   (and the same user in a different financial moment) care about different views. If it isn't already clear,
   offer the common perspectives below (2–4 targeted questions max, with your recommendation) instead of a
   vague "which sections do you want?":
   - **Expense × income by month** [`expense-income-by-month`] (am I earning more than I spend? trend over
     N months) → `aggregate_spending` with `groupBy: month` per type, or per-month `get_spending_summary`.
   - **Where the money goes** [`where-the-money-goes`] (category breakdown, top categories, month over
     month) → `aggregate_spending` with `groupBy: category` (+ `month` for evolution), `get_spending_summary`.
   - **Cash flow / balances now** [`cash-flow`] (what do I have, per account/type) → `get_account_balances`
     (+ `type` filter), accounts list.
   - **Projection** [`projection`] (where will I land at end of month, counting pending/scheduled) →
     `get_account_balances` with `projectedAsOf`, pending transactions via `search_transactions`
     (`status: "pending"`).
   - **Committed / recurring obligations** [`recurring-obligations`] (subscriptions, fixed bills, what's due
     next) → recurring list; card bills via the bills endpoints (status, due dates).
   - **Credit card view** [`credit-card-view`] (current fatura, per-card spend) → the bills endpoint for
     status/dates/total; for the category breakdown, use the bill's own transaction list, not
     `aggregate_spending` — see the note below.

   **Why not `aggregate_spending` for a card's category breakdown**: it only counts `effective` transactions
   (never `pending`), so on a still-open cycle with pending installment legs the category total will be
   *lower* than the bill's own total shown right above it on the same page — a visible, confusing
   inconsistency, not just an edge case. The bill's transaction list already reflects everything counted
   toward that bill regardless of status, so group those rows by category client-side instead; the two
   figures then always reconcile.

   Also ask, when relevant: time range (current month vs last N months), which accounts/cards matter, and
   whether they think per-currency (BRL/USD) or mostly one.
   Map each chosen perspective to one real endpoint from the contract you just read. If nothing in the
   contract covers a perspective, say so — either drop it or add a clearly labeled "coming soon" placeholder
   (see the baseline template's Installment projections section). Never invent an endpoint or fabricate a
   number to fill a gap.
3. **Decide the save target.** `save_dashboard(name, html)` is an upsert — reusing an existing name replaces
   it immediately, with no version history to recover the previous content. Ask before overwriting a
   dashboard the user may still want, or default to a new name.
4. **Start from the baseline fragment as the structural pattern**, not necessarily its content: the seeded
   `overview` dashboard, viewable at `GET /ui/overview` when the HTTP sidecar is running, is `<section>`s +
   one inline `<script>` (no page chrome of its own — the shell provides that), with one `Api` object mapping
   section → endpoint, a per-section loading/empty/error state machine, and per-currency grouping. Reuse that
   shape; change the sections/layout/endpoints to match what the user actually asked for. The fragment's
   script runs its init immediately at the end of the file (it does **not** wait for `DOMContentLoaded` —
   that only fires once for the shell page itself, never per dashboard navigation) since the shell only
   re-executes it after the fragment's markup is already in the page. If you can't view the seeded fragment
   (sidecar not running, or you're running from the published package with no local source to read), that's
   fine — the hard rules and self-check below fully specify a compliant fragment without it.
5. **Record the user's preferences in the dashboard itself** so the next change doesn't re-interrogate them:
   put a design-manifest comment at the top of the HTML. The manifest is **closed-shape only — no freeform
   text fields**, so it structurally cannot carry financial data:
   `<!-- fintrack:dashboard-manifest {"perspectives":["expense-income-by-month","cash-flow"],"range":"last-6-months","currencies":["BRL"]} -->`

   For a custom period, `range` takes the object form instead of a token — same key, not an extra one:
   `"range":{"from":"2026-01-01","to":"2026-06-30"}` (`YYYY-MM-DD`, matching FinTrack's date convention).

   - `perspectives`: array of tokens from the fixed list in step 2 — `expense-income-by-month`,
     `where-the-money-goes`, `cash-flow`, `projection`, `recurring-obligations`, `credit-card-view`.
   - `range`: either one token — `current-month`, `last-3-months`, `last-6-months`, `last-12-months`,
     `year-to-date` — or the `{"from", "to"}` object above. Never both on the same manifest.
   - `currencies`: ISO codes (`BRL`, `USD`).
   The manifest has exactly these three keys — `perspectives`, `range`, `currencies` — and no others. Ad-hoc
   context ("user tracks X separately") does not go in the manifest — keep it in conversation instead.
   (`get_preferences` returns only `{ locale, localeSource }` today, no dashboard-view state; the manifest
   is where per-dashboard view choices live.)
6. **Save it**: call `save_dashboard(name, html)`. If it's rejected (`validation`, 422), the message names
   the render-ability problem (empty content, a full `<!doctype>`/`<html>` root still present, or a script
   syntax error) — fix it and resave; the previously stored dashboard is untouched by a rejected save.
7. **Hand back the URL**: `/ui/<name>` on whatever host/port the user's FinTrack HTTP sidecar is running on
   (see the "Manual config and HTTP mode" section of the project's `README.md` — shipped with this package
   — if unsure which). Tell them to open it in a browser.

## Hard rules (never violate these)

1. **Data-less.** No amount, name, date, or other fact from FinTrack's data appears literally in the
   HTML/JS source. Every such value is read from a `fetch('/api/...')` response inside a callback, at
   runtime. Config constants (a row limit, a chart color palette, a static section title) are fine; a
   dollar amount, an account name, or a transaction description baked into the source is not.
2. **No secrets or tokens** of any kind in the file.
3. **Same-origin `/api` only, for data.** Every data fetch path is relative (`/api/...`) — never an
   absolute host — because the dashboard is served from the same FinTrack HTTP server it reads from.
4. **No external references of your own at all.** The shell already loads a pinned Chart.js from a CDN once
   (`ui/shell.html`) — a fragment just uses the global `Chart` it provides; do not add your own
   `<script src="...chart.js...">` or any other external host (fonts, icons, analytics, other CDNs). A
   fragment's only "outside" references are same-origin `/api` data fetches.
5. **Never mix currencies in one figure.** Group and render per currency exactly as the `/api`
   summary/aggregate responses already do (a `currencies` array); never sum or display BRL and USD
   together.
6. **Use the localized labels the API returns** (`typeLabel`, `categoryName`, `periodLabel`,
   `accountName`, …) instead of hardcoding English vocabulary or deriving labels from raw enum values.
7. **Every fetch-driven section has its own loading, empty, and error state.** A slow or failing endpoint
   degrades that one section — it never blanks or crashes the whole page. Use `aria-live` regions for
   dynamic containers and `role="alert"` on error messages, as the baseline fragment does.
8. **Real-time, not cached.** The fragment is re-fetched (no-cache) every time the shell loads it; freshness
   comes from fetching on every load. Never inline a "data as of <time>" snapshot as if it were live — the
   only "as of" text allowed is a client-side "last updated" label set from `new Date()` at fetch time.
9. **Accessible and responsive.** Label form controls, use semantic headings/landmarks, and keep the layout
   usable on narrow viewports (see the baseline fragment's `.dashboard-toolbar`/`.cards-grid` classes and
   `ui/app.css`'s `@media` breakpoint).
10. **A fragment, not a full page.** No `<!doctype>`, `<html>`, `<head>`, `<body>`, or `<style>` — just the
    `<section>`s and one inline `<script>`, the same shape `save_dashboard` stores and the shell injects into
    `#content`. Shared styling lives in `ui/app.css`; reuse its existing classes (`card`, `cards-grid`,
    `table-wrap`, `data-table`, `state`, `state-error`, `placeholder-card`, …) instead of inventing new ones.

## Overriding an existing dashboard

`save_dashboard` is a name-keyed upsert with no rebuild step and no version history: regenerate the full
fragment (steps 1–5) and call `save_dashboard` again with the same `name` to replace it. Once that save
succeeds, the previous content is gone — if the user is changing a dashboard they might still want, offer to
save under a new name instead of overwriting.

**Before regenerating, fetch the current dashboard (`GET /api/dashboards/:name`) and read its
`fintrack:dashboard-manifest` comment**: preserve the recorded perspectives/range/currency choices unless
the user is explicitly changing them, and carry the (updated) manifest into the new fragment. A request like
"add a projections panel" changes one section — it should not silently lose the perspectives the user
already chose.

**If you can't fetch it** — the HTTP sidecar is on by default, so this should be the exception rather than the
norm: it happens when the sidecar was explicitly disabled (`FINTRACK_HTTP=false`) or failed to bind (e.g. the
port was already taken). `GET /api/dashboards/:name` is REST-only, there is no MCP tool that reads a
dashboard's HTML back (`save_dashboard` is write-only, `list_dashboards` omits HTML), so when the sidecar
isn't reachable there's no other way to read it. Do not silently rebuild from scratch and tell the user you
"kept everything the same"; that claim would be unverifiable. Say plainly that you can't read the dashboard's
current contents back, name the reason (sidecar disabled or not running), and either ask the user to start it
(see `README.md`'s HTTP-mode section) so you can fetch it, or ask what sections/manifest they currently have
so nothing gets silently dropped. This fallback works regardless of how FinTrack was installed.

If you happen to be working from the FinTrack source repository itself (not the published package — you
have a local `src/` to read) *and* the name is `overview` with no evidence it's been customized since the
seed, you may additionally treat `src/diplomat/db/seed/dashboards.ts`'s `DEFAULT_DASHBOARD_HTML` (the
fragment content, despite the name) as a verified stand-in for "the original" instead of asking: diff your
new fragment against that source before saving, and confirm the diff is purely additive (existing sections
untouched, only the requested change applied) — don't just assert it. Treat this as an optional shortcut
available only in that specific environment, not the general-purpose fallback.

## Self-check before calling save_dashboard

- [ ] Every displayed number/name is set inside a `fetch(...).then(...)` callback — not a literal in the
      source.
- [ ] No `const|let|var <name> = [...]`/`{...}` holding what looks like real spending, transaction,
      balance, or account data.
- [ ] Every data fetch path starts with `/api/` (relative, same-origin); no other external reference at all
      (no own chart-library `<script src>` — the shell already loads one).
- [ ] Every currency-bearing section groups/loops by `currency` — nothing sums two currencies together.
- [ ] Every section has a loading, empty, and error branch.
- [ ] The content is non-empty, does **NOT** start with `<!doctype html>` or have an `<html>` root (the shell
      owns that), and every inline `<script>` is syntactically valid.
- [ ] The `fintrack:dashboard-manifest` comment is present, reflects the user's chosen perspectives, and
      contains ONLY the closed-shape keys (`perspectives` tokens, `range` token or from/to dates,
      `currencies` ISO codes) — no freeform text, no extra keys.
