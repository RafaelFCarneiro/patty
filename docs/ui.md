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
  intentional exception — its response varies by requesting User-Agent, so there's no single fixed body an
  SRI hash could pin, documented inline at that `<link>`), the left nav menu (`#dashboard-menu`), and the
  `#content` container fragments render into. Fragments load none of these themselves — Chart.js and
  Flatpickr are called as shell-provided globals (`ui/dashboards/*.html`'s date inputs call `flatpickr(...)`
  directly) — so the shell's `<head>` is the *only* place external hosts are referenced; a fragment carrying
  its own `<script src>`/`<link>` is rejected by `save_dashboard` (see Management flows below).
  `test/integration/http/dashboardTemplate.test.ts` pins the allowed host+version list for both the shell and
  every fragment.
- **`ui/app.css`** — shell/layout styling for the sidebar-nav shell (menu, toolbar chrome, Flatpickr theme
  overrides), reworked from the original per-dashboard `<style>` blocks rather than a verbatim lift of them.
- **`ui/app.js`** — the shell client: renders the menu from `GET /api/dashboards` (see the `source`
  discriminator section above for how defaults vs. customs are placed), resolves the active dashboard name
  from `location.pathname`, fetches its fragment (`GET /api/dashboards/:name`), and injects it into
  `#content`. Handles menu clicks (`history.pushState`, no reload) and direct/refresh navigation to
  `/ui/:name`. A fragment's `<script>` is inert once inserted via `innerHTML`, so `app.js` replaces it with a
  freshly created `<script>` element (standard SPA workaround) to execute it; the fragment's script runs its
  init **synchronously** at that point rather than waiting for `DOMContentLoaded` (which fires once, for the
  shell page, not per navigation).
- **`ui/dashboards/*.html`** (ADR-027 Phase 2) — the default dashboard fragments, one file per default,
  git-versioned and read-only at the install location; bootstrap reconciles them into `source: 'file'` rows.

## Routes

- **`GET /ui` and `GET /ui/:name`** (`registerUiRoutes`, `diplomat/http/routes/ui.ts`) both serve the **same
  shell file**, always `200`, `cache-control: no-cache`. There is **no server-side existence check** on
  `:name` — the shell resolves it client-side and shows a not-found state inside `#content` if the fragment
  fetch 404s; `overview` is the default for bare `/ui`.
- **`GET /ui/assets/app.css` / `GET /ui/assets/app.js`** — two fixed routes reading two fixed files (not a
  general static server), also `no-cache`.
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

## The nine default dashboards

All nine ship as `ui/dashboards/*.html` (ADR-027 Phase 2 completed the set — `overview` first, the remaining
eight joined in a follow-up conversion, all file-backed the same way): `overview`, `accounts`, `cards`,
`categories`, `comparative`, `dashboards` (a management UI for dashboards themselves), `pending`, `projections`,
`tags`. Each is registered as a `source: 'file'` row by bootstrap's directory scan, so `GET
/api/dashboards/<name>` resolves and `GET /ui`/`GET /ui/<name>` render on a fresh install before the agent
generates anything. `overview` (income/expenses/balance, spending-by-category, accounts & balances, upcoming
bills, recent transactions) is the default for bare `/ui`; the rest cover one functional area each, reachable
from the shell's nav menu.

Every default's script fetches its data same-origin from `/api/...` (accounts, categories, credit cards, bills,
transactions, tags, dashboards themselves, …) and renders whatever returns with the localized labels the API
already provides (`typeLabel`, `categoryName`, `periodLabel`, …); date inputs call the shell-provided
`flatpickr(...)` global rather than loading their own picker. Every section has its own loading/empty/error
state, so a slow or failing endpoint degrades one card, not the page.

**Every fragment embeds zero financial data or secrets** — the ADR-013 non-negotiable, held equally across all
nine. `test/integration/http/dashboardTemplate.test.ts` is the regression guard, parameterized over all nine
names: each fragment must contain a `fetch()` call, match no inline-data-blob pattern, carry no full document
root, reference no external host outside the pinned CDN allowlist, and fetch only `/api` paths that exist in
the live OpenAPI document; a companion test asserts `GET /ui` (the shell itself) references no external host
outside that same allowlist.

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

**The post-commit publish hook** lives in `diplomat/db/effects.ts`'s `attempt` (the one place a batch commits,
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
