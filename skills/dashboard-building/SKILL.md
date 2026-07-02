---
name: dashboard-building
description: Use when the user asks to build, change, extend, or "show me" a dashboard/UI for their FinTrack finances. Guides generating a data-less HTML shell that fetches live data from the FinTrack API and saving it with save_dashboard.
---

# Building a FinTrack dashboard

FinTrack dashboards are self-contained HTML pages stored server-side and served live at `GET /ui/:name`
(ADR-013). The non-negotiable rule behind everything below: **a dashboard never contains data — it fetches
it.** The page you write is layout, styling, and `fetch()` calls; every number, name, or row the user sees
comes from a same-origin `/api` response read after the page loads, every time it loads.

`save_dashboard` only rejects HTML that can't render at all (no `<html>` root, or a `<script>` syntax error)
— it does **not** check for embedded data. Following this checklist is what keeps the dashboard data-less;
the save endpoint won't catch a violation for you.

## Process

1. **Read the API contract first — never guess a path or field name.**
   - MCP: read the `fintrack://openapi` resource.
   - REST: `GET /api/openapi.json`.
   This is the source of truth for available routes, query params, and response shapes, including the
   localized labels (`typeLabel`, `categoryName`, `periodLabel`, `accountName`, …) the API already resolves
   for the user's locale.
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
     (`status: pending`).
   - **Committed / recurring obligations** [`recurring-obligations`] (subscriptions, fixed bills, what's due
     next) → recurring list; card bills via the bills endpoints (status, due dates).
   - **Credit card view** [`credit-card-view`] (current fatura, per-card spend) → bills +
     `aggregate_spending` filtered by card account.
   Also ask, when relevant: time range (current month vs last N months), which accounts/cards matter, and
   whether they think per-currency (BRL/USD) or mostly one.
   Map each chosen perspective to one real endpoint from the contract you just read. If nothing in the
   contract covers a perspective, say so — either drop it or add a clearly labeled "coming soon" placeholder
   (see the baseline template's Installment projections section). Never invent an endpoint or fabricate a
   number to fill a gap.
3. **Decide the save target.** `save_dashboard(name, html)` is an upsert — reusing an existing name replaces
   it immediately, with no version history to recover the previous HTML. Ask before overwriting a dashboard
   the user may still want, or default to a new name.
4. **Start from the baseline template as the structural pattern**, not necessarily its content: the seeded
   `overview` dashboard (`GET /ui/overview`; source `src/diplomat/db/seed/dashboards.ts`) is a single
   self-contained HTML file with inline `<style>` + inline `<script>`, one `Api` object mapping section →
   endpoint, a per-section loading/empty/error state machine, and per-currency grouping. Reuse that shape;
   change the sections/layout/endpoints to match what the user actually asked for.
5. **Record the user's preferences in the dashboard itself** so the next change doesn't re-interrogate them:
   put a design-manifest comment at the top of the HTML. The manifest is **closed-shape only — no freeform
   text fields**, so it structurally cannot carry financial data:
   `<!-- fintrack:dashboard-manifest {"perspectives":["expense-income-by-month","cash-flow"],"range":"last-6-months","currencies":["BRL"]} -->`
   - `perspectives`: array of tokens from the fixed list in step 2 — `expense-income-by-month`,
     `where-the-money-goes`, `cash-flow`, `projection`, `recurring-obligations`, `credit-card-view`.
   - `range`: one token — `current-month`, `last-3-months`, `last-6-months`, `last-12-months`,
     `year-to-date` — or explicit `"from"`/`"to"` `YYYY-MM-DD` dates.
   - `currencies`: ISO codes (`BRL`, `USD`).
   Do NOT add other keys or any freeform value. Ad-hoc context ("user tracks X separately") does not go in
   the manifest — keep it in conversation instead.
   (`get_preferences` stores only the locale today; the manifest is where per-dashboard view choices live.)
6. **Save it**: call `save_dashboard(name, html)`. If it's rejected (`validation`, 422), the message names
   the render-ability problem (missing `<html>` root, or a script syntax error) — fix it and resave; the
   previously stored dashboard is untouched by a rejected save.
7. **Hand back the URL**: `/ui/<name>` on whatever host/port the user's FinTrack HTTP sidecar is running on
   (see `CLAUDE.md` HTTP sidecar section if unsure which). Tell them to open it in a browser.

## Hard rules (never violate these)

1. **Data-less.** No amount, name, date, or other fact from FinTrack's data appears literally in the
   HTML/JS source. Every such value is read from a `fetch('/api/...')` response inside a callback, at
   runtime. Config constants (a row limit, a chart color palette, a static section title) are fine; a
   dollar amount, an account name, or a transaction description baked into the source is not.
2. **No secrets or tokens** of any kind in the file.
3. **Same-origin `/api` only, for data.** Every data fetch path is relative (`/api/...`) — never an
   absolute host — because the dashboard is served from the same FinTrack HTTP server it reads from.
4. **The only external reference allowed at all is a pinned chart library from a CDN**, matching the
   baseline template's `<script src="https://cdn.jsdelivr.net/npm/chart.js@<version>/..." integrity="..."
   crossorigin="anonymous">` — a pinned version with an SRI hash, loading code and nothing else. Do not add
   any other external host (fonts, icons, analytics, other CDNs) and do not use an external reference for
   data.
5. **Never mix currencies in one figure.** Group and render per currency exactly as the `/api`
   summary/aggregate responses already do (a `currencies` array); never sum or display BRL and USD
   together.
6. **Use the localized labels the API returns** (`typeLabel`, `categoryName`, `periodLabel`,
   `accountName`, …) instead of hardcoding English vocabulary or deriving labels from raw enum values.
7. **Every fetch-driven section has its own loading, empty, and error state.** A slow or failing endpoint
   degrades that one section — it never blanks or crashes the whole page. Use `aria-live` regions for
   dynamic containers and `role="alert"` on error messages, as the baseline template does.
8. **Real-time, not cached.** `GET /ui/:name` is already served with no-cache headers; freshness comes from
   the page fetching on every load. Never inline a "data as of <time>" snapshot as if it were live — the
   only "as of" text allowed is a client-side "last updated" label set from `new Date()` at fetch time.
9. **Accessible and responsive.** Label form controls, use semantic headings/landmarks, and keep the layout
   usable on narrow viewports (see the baseline template's `@media` breakpoint).
10. **Self-contained single file.** No separate `.js`/`.css` files — inline `<style>` and `<script>` in the
    one HTML string, matching how `save_dashboard`/`GET /ui/:name` store and serve a single string.

## Overriding an existing dashboard

`save_dashboard` is a name-keyed upsert with no rebuild step and no version history: regenerate the full
HTML (steps 1–5) and call `save_dashboard` again with the same `name` to replace it. Once that save
succeeds, the previous HTML is gone — if the user is changing a dashboard they might still want, offer to
save under a new name instead of overwriting.

**Before regenerating, fetch the current dashboard (`GET /api/dashboards/:name`) and read its
`fintrack:dashboard-manifest` comment**: preserve the recorded perspectives/range/currency choices unless
the user is explicitly changing them, and carry the (updated) manifest into the new HTML. A request like
"add a projections panel" changes one section — it should not silently lose the perspectives the user
already chose.

## Self-check before calling save_dashboard

- [ ] Every displayed number/name is set inside a `fetch(...).then(...)` callback — not a literal in the
      source.
- [ ] No `const|let|var <name> = [...]`/`{...}` holding what looks like real spending, transaction,
      balance, or account data.
- [ ] Every data fetch path starts with `/api/` (relative, same-origin); the only other external reference
      is the one approved chart-library `<script src>`.
- [ ] Every currency-bearing section groups/loops by `currency` — nothing sums two currencies together.
- [ ] Every section has a loading, empty, and error branch.
- [ ] The file starts with `<!doctype html>` or has an `<html>` root, and every inline `<script>` is
      syntactically valid.
- [ ] The `fintrack:dashboard-manifest` comment is present, reflects the user's chosen perspectives, and
      contains ONLY the closed-shape keys (`perspectives` tokens, `range` token or from/to dates,
      `currencies` ISO codes) — no freeform text, no extra keys.
