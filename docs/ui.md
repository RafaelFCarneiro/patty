# FinTrack v2 — UI / `/ui` surface (as built)

> The browser dashboard surface: the app shell, dashboard fragments, the file/inline `source` model, and
> SSE live-update. Architectural decisions + rationale: **ADR-013** (data-less local dashboards) and
> **ADR-027** (app shell, file-backed defaults, fragments, live update). This file is the **as-built**
> reference for `/ui`; `docs/architecture.md` points here rather than carrying the detail.

## Model: the `dashboards` table

`dashboards` (`id` PK, `name` UNIQUE, `html` nullable, `source: inline|file` DEFAULT `inline`, `path` nullable,
`updated_at`, `version`) stores **content fragments**, keyed by `name` for every consumer-facing surface. `id`
is a surrogate identity, internal only (Feature Design 013 Phase 1) — never on the wire, never a tool argument.

A **fragment** is `<section>`-level markup plus an inline `<script>` that runs its own init immediately once
injected — **not** a full HTML page (no `<!doctype>`/`<html>`/`<head>` root; the shell owns those and the one
Chart.js `<script>`).

A `CHECK` constraint (`dashboard_source_content`, `diplomat/db/schema.ts`) enforces **exactly one of
`html`/`path` per source** at the schema level; `saveDashboard`/`renameDashboard` (`controllers/dashboards.ts`)
and `adapters/dashboards.ts`'s `modelToDb` enforce the same on the write side.

## `source`: the sole default/custom discriminator (ADR-027 Phase 2)

There is no separate `kind` column — `source` alone distinguishes default from custom:

- **`file`** — content resolved by reading a repo-relative `.html` file under `ui/dashboards/` at read time
  (`dashboardsRepo`'s `get`/`findByName`); the row's `html` is always `NULL`. File reads are I/O, so they live
  in the repo (never in the pure `adapters/dashboards.ts`), and are cached in memory for the process lifetime.
  `path` is confined to `ui/dashboards/` by a resolve-and-prefix check (`resolveDashboardFilePath`) —
  defense-in-depth, since `path` is only ever bootstrap-supplied.
- **`inline`** — content stored in the `html` column; `path` is always `NULL`. Custom dashboards, authored via
  `save_dashboard`.

**Security invariant (non-negotiable):** only bootstrap ever registers a `file`-backed row. **`save_dashboard`
always stores `source: 'inline'`, `path: null`** — regardless of what the target name previously was, saving
over a file-backed default's name *detaches* it into a custom inline row. A custom dashboard can therefore
never carry a caller-influenced `path`, which closes the path-traversal surface entirely.

The menu (`ui/app.js`'s `renderMenu`) places the eight most-used defaults directly in the sidebar and the rest
in a `#more-dropdown` overflow menu, split by two hardcoded name-order lists (`mainSequence`/`dropdownSequence`)
rather than by `source` — every file-backed default has a fixed slot either way. `inline` (custom) dashboards
are never in either list, so they always fall through to the dropdown, appended after a plain `<hr
class="sidebar-divider">` separator (`ui/app.css`) once at least one exists — there's no labeled "Custom"
group, just a divider ahead of whatever customs `list_dashboards` returns.

## The app shell (ADR-027 Phase 1)

Real, version-controlled files at the package root, sibling to `src/`/`drizzle/`, shipped via `package.json`'s
`files` array. `ui/` is resolved relative to the serving module (`fileURLToPath(new URL('../../../../ui',
import.meta.url))`), the same pattern bootstrap uses for `drizzle/`, so it works under `tsx src/...` (dev) and
`node dist/...` (published) regardless of `cwd`.

- **`ui/shell.html`** — shared `<head>` (links `ui/app.css`; loads Chart.js, Flatpickr, and Font Awesome from
  a CDN, each version-pinned with an SRI `integrity` hash (#165); Google Fonts' CSS2 API is the one
  intentional exception — its response varies by requesting User-Agent, so there's no single fixed body that
  an SRI hash could pin, documented inline at that `<link>`), the left nav menu (`#dashboard-menu`), and the
  `#content` container fragments render into. Fragments load none of these themselves — Chart.js and
  Flatpickr are called as shell-provided globals (`ui/dashboards/*.html`'s date inputs call `flatpickr(...)`
  directly) — so the shell's `<head>` is the *only* place external hosts are referenced; a fragment carrying
  its own `<script src>`/`<link>` is rejected by `save_dashboard` (see Management flows below).
  `test/integration/http/dashboardTemplate.test.ts` pins the allowed host+version list for both the shell and
  every fragment.
- **`ui/app.css`** — shell/layout styling for the sidebar-nav shell (menu, toolbar chrome, Flatpickr theme
  overrides), reworked from the original per-dashboard `<style>` blocks rather than a verbatim lift of them.
  Also owns the shared dashboard-fragment component classes — see below.
- **`ui/app.js`** — the shell client: renders the menu from `GET /api/dashboards` (see the `source`
  discriminator section above for how defaults vs. customs are placed), resolves the active dashboard name
  from `location.pathname`, fetches its fragment (`GET /api/dashboards/:name`), and injects it into
  `#content`. Handles menu clicks (`history.pushState`, no reload) and direct/refresh navigation to
  `/ui/:name`. A fragment's `<script>` is inert once inserted via `innerHTML`, so `app.js` replaces it with a
  freshly created `<script>` element (standard SPA workaround) to execute it; the fragment's script runs its
  init **synchronously** at that point rather than waiting for `DOMContentLoaded` (which fires once, for the
  shell page, not per navigation).
- **`ui/money.js`** (ADR-026 Phase 1) — shell-provided `window.formatMoney(value, currencyCode, opts?)`, loaded
  before `app.js` so it's ready before the first fragment script runs. ISO fiat (BRL/USD) formats via
  `Intl.NumberFormat`'s currency style unchanged; a non-ISO code (USDC/BTC) falls back to that currency's own
  symbol + decimals instead — **not** via try/catch (a syntactically-valid-but-unrecognized 3-letter code like
  `BTC` never throws there; it silently mis-formats with a fiat-shaped 2 decimals and no real symbol), but via
  an explicit `Intl.supportedValuesOf('currency')` membership check. Symbol/decimals come from
  `window.__fintrackCurrencies`, populated once at shell boot from `GET /api/currencies`
  (`app.js`'s `bootPromise`, sequenced before the first `loadDashboard()` call so the metadata is never missing
  on first paint). Every fragment that formats money calls this instead of its own `Intl.NumberFormat(...,
  {style:'currency', ...})`. It also exports `window.DEFAULT_CURRENCY` ('BRL') and the currency-map arithmetic
  every dashboard's per-currency aggregation depends on (issue #174) — `addMultiCurrency(map, currency,
  amount)`, `valueIn(map, currency)`, `primaryCurrencyOf(map)`, `magnitudeOf(map)`, `mergeCurrencyMaps(...maps)`
  (additive; `Object.assign`/spread would silently drop a currency present in more than one input map instead
  of summing it), and `formatMultiCurrencyWith(map, formatFn, delimiter?)` (renders every currency in a map
  side by side via the caller's own `formatFn`; skips a zeroed-out currency only when a non-zero one is ALSO
  present — an all-zero map, e.g. a USD-only month whose income and expense net to exactly zero, still names
  its real currencies instead of silently falling back to a DEFAULT_CURRENCY-labeled zero, which would
  mislabel that USD zero as BRL). These are locale-independent operations (`addMultiCurrency` intentionally
  mutates its `map` argument in place — an accumulator, not a pure function — the rest don't mutate their
  inputs), so they're defined once here instead of copy-pasted into every fragment; each fragment still owns
  its own thin `formatCurrency` wrapper
  locally (calling `window.formatMoney`) plus a one-line `formatMultiCurrency(map, delimiter)` that just
  delegates to `formatMultiCurrencyWith(map, formatCurrency, delimiter)` — `formatCurrency` needs the
  fragment's own resolved UI locale (`currentLocale`), which this shell-loaded, load-once module has no
  access to, so the delegation is the only way to reuse the shared sort/fallback logic without also sharing
  that locale dependency.
- **`ui/dashboards/*.html`** (ADR-027 Phase 2) — the default dashboard fragments, one file per default,
  git-versioned and read-only at the install location; bootstrap reconciles them into `source: 'file'` rows.
  `accounts.html` and `budget.html` render an opt-in converted grand total where the backend already exposes
  one — `accounts.html` reads `get_account_balances`'s `consolidatedNetWorth` (`{ baseCurrency, total,
  excluded }`) as-is, no `displayCurrency` param needed; `budget.html` requests `get_budget_status` with
  `?displayCurrency=<baseCurrency>` and reads its `converted` block (`{ displayCurrency, total, stale, asOf,
  excluded }`, Feature Design 021). `overview.html` follows `accounts.html`'s pattern: its own
  `/api/accounts/balances` call already returns `consolidatedNetWorth`, so the "Net worth (home currency)"
  badge on the Bank Accounts widget needs no extra fetch — same `window.formatMoney(total, baseCurrency)` +
  excluded-count note rendering, with an "n.a." fallback when the field is absent (e.g. the balances fetch
  failed) rather than showing a fabricated number — unaffected by the issue #174 fix below. `budget.html`,
  `overview.html`, `comparative.html`, and `projections.html` compute their other KPI, calendar/day,
  category, and heat-map totals client-side from raw `/api/transactions`, bucketed per currency (issue #174
  fix) via `ui/money.js`'s shared `addMultiCurrency`/`valueIn`/`primaryCurrencyOf`/`magnitudeOf`/
  `mergeCurrencyMaps`/`formatMultiCurrencyWith` (originally defined once per fragment — `budget.html` first —
  then consolidated into `money.js` so the four fragments share one implementation instead of four copies):
  every accumulator is a `{currency: amount}` map rendered with each fragment's own local
  `formatMultiCurrency` (a thin delegate to the shared `formatMultiCurrencyWith`, never a single blended
  number), a row/cell's own percentage or bar width compares same-currency amounts only (`primaryCurrencyOf`
  picks that row's representative currency), and Chart.js series (needing one numeric series) render the
  primary currency only, labeled via a tooltip/axis-tick callback calling `formatCurrency(value, currency)`
  (matching `budget.html`'s existing chart-formatting pattern) so a USD/BTC-only chart isn't shown as bare
  unitless numbers — the KPI/table text above them already shows every currency
  correctly. `overview.html`'s compact calendar day cells (no room for multiple currency lines) resolve
  income/expense/transfer as three independent `primaryCurrencyOf` picks — never one shared currency for
  the whole day, which would silently zero out (and hide) a real flow whenever it happened to be in a
  different currency than whichever flow dominated that day — and render each via `formatCurrencyNoSymbol`;
  the full per-transaction, per-currency breakdown is one click away in the day-details drawer.
  `comparative.html`'s category sort order and `projections.html`'s heat-map cell/row/column totals combine
  a category's effective + pending (or a cell's own transactions) with `mergeCurrencyMaps` rather than
  `Object.assign`/spread, which would silently let one currency's pending amount overwrite that same
  currency's effective amount instead of summing them. The heat map's color-intensity scale (opacity) also
  tracks its running max **per currency** rather than one shared max across the whole matrix — comparing a
  0.05 BTC cell's raw units directly against a 10,000 BRL cell's would always crush BTC toward the opacity
  floor regardless of its own relative size, so each currency's cells are only ever compared against that
  same currency's own max. Because `formatCurrency` now reads `currentLocale`, `comparative.html`'s and
  `projections.html`'s bootstrap sequencing was fixed to `await checkLocale()` before `initDashboard()`
  runs (their `runInit()` — matching `budget.html`'s/`overview.html`'s existing pattern) — `checkLocale()`
  only re-translates static `data-i18n` text afterward, it never re-renders the dynamic money values
  `initDashboard()` already painted, so a locale fetch that lost the race would otherwise leave every KPI/
  category/heat-map number stuck in the default `en` formatting for a pt/es user. That `await` needed its
  own stale-fragment guard, the way `overview.html`'s `initOverview` IIFE already has: `runInit()` in both
  files captures a function-local `const ownFragmentMarker` (their existing `panelsLoading`/`heatmapLoading`
  loading-overlay element) *before* the await and checks `ownFragmentMarker.isConnected` after it, bailing
  out rather than calling `initDashboard()` if the user navigated away while `checkLocale()`'s
  `/api/status` request was in flight. The capture has to be into a function-local variable, not read
  directly off `panelsLoading`/`heatmapLoading` themselves — those are top-level `var`s, so they live on
  the one `window` every fragment script executes in, and `comparative.html`/`projections.html` even
  declare the identical two names; a later-loaded fragment's script would otherwise silently overwrite them
  out from under a still-pending older continuation. The month/year/heatmap-months change listeners are
  registered inside `runInit()` too, after the same `await`+guard — registering them earlier (as both
  fragments originally did) would let a user interaction call `loadTransactionsData()` before
  `checkLocale()` resolves, rendering with the default locale the same way a lost `initDashboard()` race
  would. None of the three
  fragments convert across currencies client-side (that would duplicate the backend's
  `consolidateInCurrency` rate/staleness logic in JS); a converted grand total for
  `comparative.html`/`projections.html`, matching `budget.html`'s `displayCurrency` pattern, would require
  moving their aggregation to a server endpoint first and is deferred as a follow-up (issue #193).

## Shared component classes across fragments (issue #164)

`ui/app.css` owns the base rule for nine component classes independently reused across the nine default
fragments (`.spinner`, `.loading-overlay`, `.toast-container`/`.toast`, `.modal-overlay`/`.modal-box`/
`.modal-title`, `.panel`, `.form-group label`/`.form-control`/`.form-control:focus`, `.kpi-card`,
`.btn-action-primary`, `.net-worth-summary`/`.nw-label`/`.nw-total`/`.nw-excluded`) instead of each fragment
defining its own full copy. What each fragment kept locally, and why, follows one rule:

**A property is only moved into the shared base if every fragment that uses the class declares that
property at all** — either with the identical value everywhere (safe outright), or with the most common
value becoming the base default while every fragment whose value differs (whether that's a true majority or
just a plurality) keeps a small local override for just that one property (in the fragment's own `<style>`
block, injected into `#content` after `app.css` in DOM order, so it wins the cascade for anything it
declares). A property a fragment never declared for that class is **never** centralized,
even when most fragments agree on it — centralizing it would make that fragment silently inherit a property it
never asked for. This is why, for example, `.modal-overlay`'s `background`/`z-index` are shared with per-file
overrides (every user sets both, just to different values) while its `width`/`height` stay fully local
(`dashboards.html`'s modal uses `top/right/bottom/left` insets instead and never declared them at all).

Several components turned out too structurally divergent to share a *full* base safely under this rule:
`dashboards.html`'s `.modal-card`/`.modal-header`/`.btn-close-modal` (a different markup shape from every
other fragment's `.modal-box`, sharing only `.modal-overlay`/`.modal-title`'s name with the lifted base), and
the `.toast` implementations in `categories.html`/`dashboards.html` (solid background, no backdrop-filter, a
different animation) and `tags.html`/`overview.html` (each with their own container geometry or, for
`overview.html`, no container at all — a single persistent `.toast` element toggled by a `.show` class
instead). These four still inherit the handful of `.toast`/`.toast-container` properties that *are* universal
across every consumer (`align-items`, `border`, `border-radius`, `display`, `gap`) from `app.css`'s base —
they're not fully self-contained — but every property specific to their own divergent shape (background,
animation, timing, sizing, container geometry) stays in their own `<style>` block, declared explicitly, so
none of that divergent styling leaks between fragments.

One property was deliberately kept local everywhere despite passing the rule above: `.btn-action-primary`'s
`display` is declared by all six of its consuming fragments (three `flex`, three `inline-flex`), which
technically qualifies for a majority-default-plus-override lift like every other divergent property — but it
was left fully local to each fragment instead, favoring the simplicity of "every fragment's own rule is
self-contained for this one property" over chasing the base-vs-override split for a single, cheap-to-repeat
declaration. State-modifier rules the original issue also named as candidates (`:hover`/`:disabled` on
`.btn-action-primary`, and `pending.html`'s richer `.kpi-card` variants — `:hover`, `.income`/`.expense`/
`.net`) never shared enough structure across fragments to lift safely either, and stay fragment-local.

`.net-worth-summary`/`.nw-*` joined the shared base later, once `overview.html` reused `accounts.html`'s
net-worth badge (see the `ui/dashboards/*.html` bullet above): `.net-worth-summary`, `.nw-label`, `.nw-total`,
and `.nw-excluded` are identical in both, so they moved to `ui/app.css`; `.nw-total.na` (the "n.a." fallback for
a missing `consolidatedNetWorth`) is declared only by `overview.html` — `accounts.html` hides the block
outright instead — so it's never centralized and stays local to `overview.html`'s own `<style>` block.

Verified with zero visual regression: for every fragment, `getComputedStyle` was captured (as a single hash
over the full property set of every one of these selectors) before and after the refactor and confirmed
byte-for-byte identical — not just spot-checked.
[#164](https://github.com/RafaelFCarneiro/fintrack/issues/164) tracked this as deferred work when the
fragments were first converted to files.

## Routes

- **`GET /ui` and `GET /ui/:name`** (`registerUiRoutes`, `diplomat/http/routes/ui.ts`) both serve the **same
  shell file**, always `200`, `cache-control: no-cache`. There is **no server-side existence check** on
  `:name` — the shell resolves it client-side and shows a not-found state inside `#content` if the fragment
  fetch 404s; `overview` is the default for bare `/ui`.
- **`GET /ui/assets/app.css` / `GET /ui/assets/app.js` / `GET /ui/assets/money.js`** — three fixed routes
  reading three fixed files (not a general static server), also `no-cache`.
- **`GET /ui/events`** — the SSE live-update stream (see below).
- These are browser-facing routes, **not** `RouteDefinition`s, so `/ui*` is deliberately excluded from the
  `/api` OpenAPI document (that document exists to give agents `fetch()` shapes for the JSON API). Dashboard
  *management* (list/get/save/delete/rename) has full REST parity under `/api/dashboards*` and is documented
  there like every other route.

`GET /api/dashboards/:name` returns a dashboard as JSON (`{ name, html, updatedAt, source }`) with
`cache-control: no-cache` (file-backed content can change on disk); absent name → `unknown_dashboard` (404).

## Bootstrap reconciliation

`seedDashboards` (`diplomat/db/bootstrap.ts`) **reconciles rows to the files present** under `ui/dashboards/`
on every boot (`listDefaultDashboardFiles`): every `*.html` there becomes a `source: 'file'` row named after
its filename (`overview.html` → `overview`), via `onConflictDoNothing` on the `name` UNIQUE constraint —
**dropping a new default file in that folder needs no code change**. A `save_dashboard` override (which detaches
the name to `inline`) survives future restarts, because bootstrap never re-seeds over a name that already
exists; the file's own name re-seeds only if it becomes free again (e.g. after `delete_dashboard`).

## Management flows (`controllers/dashboards.ts`, all FC/IS)

- **`save_dashboard` / `POST /api/dashboards`** — an upsert by name. Before persisting, `saveDashboard` runs
  `findHtmlValidationIssues` (`logic/dashboard.ts`, pure) and rejects with `validation` (422) on: empty
  content; a full `<!doctype>`/`<html>` document root (the shell owns that now — inverted from the pre-ADR-027
  check); an external `<script src>` reference (fragments carry zero external references — the client also
  drops any `src`-bearing script as defense-in-depth); or an inline `<script>` that fails to *compile* (via
  Node's `vm.Script` — checked, never executed). This is a narrow render-ability check, **not** sanitization
  (full sanitization stays out of scope for this local single-user app, ADR-013). Always builds
  `source: 'inline'`, `path: null`.
- **`delete_dashboard` / `DELETE /api/dashboards/:name`** — idempotent (mirrors `delete_tag`): absent →
  `{ deleted: false }`, no write; present → a version-guarded `remove`, `{ deleted: true }`. Never an error.
- **`rename_dashboard` / `POST /api/dashboards/:name/rename`** — the capability the surrogate `id` unlocks
  (Feature Design 013 Phase 3): guards `newName` is free (`dashboardErrors.duplicateName` if taken), then emits
  a version-guarded `update` carrying the same `id`/`html` and the entity's `source`/`path` **unchanged** — so
  a renamed default stays file-backed under its new name.

## The ten default dashboards

All ten ship as `ui/dashboards/*.html` (ADR-027 Phase 2 completed the original nine — `overview` first, the
remaining eight joined in a follow-up conversion, all file-backed the same way; `budget` joined later, same
mechanism): `overview`, `accounts`, `budget`, `cards`, `categories`, `comparative`, `dashboards` (a management UI
for dashboards themselves), `pending`, `projections`, `tags`. Each is registered as a `source: 'file'` row by
bootstrap's directory scan, so `GET /api/dashboards/<name>` resolves and `GET /ui`/`GET /ui/<name>` render on a
fresh install before the agent generates anything. `overview` (income/expenses/balance, spending-by-category,
accounts & balances, upcoming bills, recent transactions) is the default for bare `/ui`; the rest cover one
functional area each, reachable from the shell's nav menu.

Every default's script fetches its data same-origin from `/api/...` (accounts, categories, credit cards, bills,
transactions, tags, budgets, dashboards themselves, …) and renders whatever returns with the localized labels
the API already provides (`typeLabel`, `categoryName`, `periodLabel`, …); date inputs call the shell-provided
`flatpickr(...)` global rather than loading their own picker. Every section has its own loading/empty/error
state, so a slow or failing endpoint degrades one card, not the page.

**Every fragment embeds zero financial data or secrets** — the ADR-013 non-negotiable, held equally across all
ten. `test/integration/http/dashboardTemplate.test.ts` is the regression guard, parameterized over all ten
names: each fragment must contain a `fetch()` call, match no inline-data-blob pattern, carry no full document
root, reference no external host outside the pinned CDN allowlist, fetch only `/api` paths that exist in the
live OpenAPI document, and — checked independently of that OpenAPI-membership check, so a fetch target that
isn't a documented `/api` path fails loudly instead of silently passing through unchecked — target only a
same-origin `/api/*` path when expressed as a literal or template literal (no `/mcp`, no other origin; a
`fetch(someVariable)` call is opaque to this static check either way and stays uncovered); a companion test
asserts `GET /ui` (the shell itself) references no external host outside that same allowlist.

`skills/dashboard-building/SKILL.md` is the guardrail checklist an MCP client follows to build or adapt a
dashboard: read the contract (`fintrack://openapi`) first, map each section to a real endpoint, start from the
baseline fragment, and self-check (fragment not full page; no embedded data; same-origin `/api` only; no own
`<script src>`; per-currency grouping; localized labels; loading/empty/error states) before calling
`save_dashboard`. Docs-only — no runtime behavior depends on it — shipped in the npm package.

## Live update — SSE, entity-tagged (ADR-027 Phase 3)

**The change bus** (`src/diplomat/changeBus.ts`) is a plain `EventEmitter` wrapper — `createChangeBus()`
returns `{ publish, subscribe }`. It sits at the `diplomat/` root, owned by neither surface. `createChangeBus()`
is composition-root-only (called once in `main.ts` / `test/integration/app-builder.ts`); `diplomat/db` and
`diplomat/http` import only the `PublishChange`/`ChangeBus` **types** and receive the bound function as a
parameter — the same crossing pattern as `RunEffects`/`resetLocale`. No external broker: the MCP server, HTTP
sidecar, and scheduler share one process (ADR-024), so an in-process emitter is the whole mechanism.

**The post-commit publish hook** lives in `@rafaelfcarneiro/effect-runner`'s engine (`attempt` (the one place a batch commits,
shared by `runEffects` and `runEffectsSequence`): once `applyBatch` reports `applied: true`, the deduped entity
tags of every outcome that itself `applied: true` are published. An idempotent-duplicate insert
(`applied: false`) changed nothing, so its entity is never published; a version-conflict retry's failed
attempts publish nothing (only the eventual successful commit does). `publish` is the last parameter of
`runEffects`/`runEffectsSequence`, defaulting to a no-op, so existing direct callers (chiefly tests) are
unaffected — only the composition root binds the real bus.

**`GET /ui/events`** (`registerUiEventsRoute`) is the shell's `EventSource` target. The handler calls
`reply.hijack()` (an SSE stream never ends like a normal response), `reply.raw.writeHead()` +
`reply.raw.flushHeaders()` (Node doesn't put headers on the wire until the first write, so without the flush a
client with nothing yet to publish would hang), and writes `data: {"entities":[...]}\n\n` on every publish for
as long as the client stays connected. `reply.raw.on('close', unsubscribe)` cleans up per connection; the
publish callback checks `reply.raw.destroyed` before writing (a publish can race a disconnect not yet seen by
the close handler). `buildHttpApp`'s Fastify instance sets `forceCloseConnections: true` so `app.close()`
doesn't hang forever on a long-lived SSE stream at shutdown.

**The shell forwards, the fragment decides.** `ui/app.js` opens exactly one `EventSource('/ui/events')` for the
page's whole lifetime (fragment swaps never reopen it) and, on each message, calls
`window.fintrackOnDataChanged(entities)` if the loaded fragment defined it — the shell knows nothing of a
fragment's internal sections, only this one well-known global slot. `renderFragment` resets the slot to `null`
before tearing down the outgoing fragment (never after injecting the new one), so a stale closure can't fire.
The baseline `overview.html` implements the contract: a `SECTION_ENTITY_DEPENDENCIES` map declares which entity
tags feed each section loader, and `onDataChanged` refetches only the sections whose dependencies intersect the
published entities. A fragment that never sets the hook simply has no live update, same as before this phase.

**Known limit (by design, ADR-027):** the change bus reaches only subscribers on this process — a write from a
*different* stdio server won't push here. Mitigated because ADR-024 steers multi-client use to the single
HTTP-transport server; a periodic client-side poll can backstop if cross-process live-update ever matters.
