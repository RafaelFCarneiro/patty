# ADR-027: UI app shell — shared chrome, file-backed default dashboards, fragment content, live updates

**Status:** Accepted · **Date:** 2026-07-26 · **Deciders:** Rafael · Extends and revises **ADR-013** (LLM-
generated, data-less local dashboards over the HTTP API). Builds on **ADR-025** (per-domain edge organization —
the new UI routes live in `diplomat/http/routes/ui.ts`), the FC/IS effect runner (**ADR-021/022** — the source
of the change-event signal), and the local-first, zero-build, single-Fastify posture (**ADR-004/007**, ADR-013).

## Context

The `/ui` surface today is a set of **standalone HTML pages** stored in the `dashboards` table (nine on this
install: overview, accounts, cards, categories, tags, pending, projections, comparative, and a gallery). Each
page carries its **own inline `<style>`, its own `<head>`, its own Chart.js and fetch logic**, and they don't
link to one another. The seeded default (`overview`) lives as a ~500-line **HTML string literal** in
`seed/dashboards.ts` — version-controlled only as an un-editable, un-diffable TS constant. Four gaps:

- **No shared chrome.** Style and layout are duplicated per page; there is no menu tying the pages together.
- **Defaults aren't real files.** The app-provided dashboards can't be edited/reviewed as HTML in git.
- **No live update.** An MCP write (add a transaction, edit a value) doesn't reflect in an open `/ui` page until
  a manual refresh.
- **Custom vs default is implicit.** All dashboards are one undifferentiated list.

The user wants: keep the current visual style exactly; ship the nine as **defaults for every install**; let users
still build **custom** dashboards, surfaced under a menu; move shared CSS (and the default pages) to **real
files under git**; **live-update** the UI when the MCP changes data; all on the **same Fastify** server, no build
step, no separate frontend host.

## Decision

Introduce an **app shell** that hosts dashboard **content fragments**, with shared assets as **real files**, a
**`source` discriminator** on the dashboard entity so defaults are file-backed, and **SSE** live-update driven by
the effect runner. Everything stays vanilla HTML/CSS/JS on the existing Fastify — no framework, no build.

### 1. App shell + fragments (replaces standalone pages)

- **`ui/shell.html`** (a real file, served at `GET /ui`) provides the shared `<head>` (links `app.css` + Chart.js),
  the **menu bar**, and a **`#content` container**. `GET /ui` (and `/ui/:name`) serves the shell; the client
  loads the selected dashboard into `#content` — `overview` is the **home** (`/ui` → overview).
- A dashboard is now a **content fragment** (its `<section>`s + an init function that fetches `/api` and renders
  into the container), *not* a full page. The shell fetches the fragment (`GET /api/dashboards/:name`) and injects
  it; client-side navigation between dashboards is instant.
- **`ui/app.js`** (a real file) is the shell client: render the menu from `list_dashboards`, load fragments, open
  the SSE stream. **`ui/app.css`** holds the shared styles lifted **verbatim** from today's dashboards (the look
  is preserved byte-for-byte). Both served statically (`/ui/assets/*`).

### 2. `source` discriminator — default dashboards are file-backed

The `dashboards` entity gains **`source: 'inline' | 'file'`** and a nullable **`path`**:

- **`file`** — content read from a repo-relative `.html` file at serve time (e.g. `ui/dashboards/overview.html`).
  **Default** dashboards ship this way: real, git-versioned, editable fragment files, bundled with the package.
- **`inline`** — `html` stored in the DB, as today. **Custom** dashboards: authored via `save_dashboard`.

`source` *is* the default/custom distinction (no separate `kind` column): the menu renders **file**-backed
dashboards as its main items and **inline** ones under a **"Custom"** submenu, grouping straight off
`list_dashboards` (which now returns `source`). This retires the `overview` HTML-string seed — the default set
becomes `ui/dashboards/*.html`.

**Security + integrity (non-negotiable):** only the app (bootstrap) ever registers `file`-backed dashboards, and
their `path` is resolved **strictly within** `ui/dashboards/` (no traversal). **`save_dashboard` always stores
`inline`** — a custom dashboard can never be file-backed, which closes the path-traversal surface entirely.
Default files are **read-only** at the install location (the user forks/contributes to change one; they make
their own via customs).

### 3. Live update — SSE, entity-tagged, from the effect runner

- The shell opens an **`EventSource`** to `GET /ui/events`. On an MCP/HTTP write, an **in-process event bus**
  publishes right after `runEffects` commits — carrying the **entity tags** of the applied `Persistable` batch
  (which the FC/IS runner already holds). The shell receives `{ entities: [...] }` and **re-fetches only the
  sections whose data those entities feed** (a section declares which entity tags it depends on).
- **In-process, zero-infra** — the MCP server, HTTP sidecar, and scheduler share one process (ADR-024 context),
  so the bus is a plain `EventEmitter`; no external pub/sub, local-first preserved.
- **Known limit:** the bus notifies browsers on the **same process**. A write from a *different* stdio server
  won't push here — mitigated because ADR-024 steers multi-client use to the single HTTP-transport server, and a
  light periodic poll can backstop if cross-process live-update ever matters. Ship SSE-in-process first.

### 4. Same server, no build

Fastify serves the shell, the static `ui/assets/*`, the `/api` data, `GET /ui/events` (SSE), and the MCP
endpoint — one process. All client code is vanilla (fetch, `EventSource`, Chart.js from CDN). No React/Vite, no
separate host: the zero-build, local-first posture (ADR-004/007/013) is unchanged.

## Options Considered

- **Shell + `#content` container (chosen)** vs per-page shared-component imports — the shell holds chrome once and
  gives a single long-lived page for the SSE connection; per-page imports would need server-side templating,
  fighting the no-build model.
- **Fragment content (chosen)** vs iframe-per-dashboard — fragments give a genuinely unified app (shared CSS/JS,
  in-page nav, direct DOM for live-update); iframes avoid converting the nine but isolate styles, duplicate asset
  loads, and make live-update cross a frame boundary. Accepted cost: a one-time conversion of the nine + a small
  change to the authoring contract (fragment, not full page).
- **File-backed default rows (chosen)** vs pure-directory discovery — file-backed rows keep the entity uniform
  (`list_dashboards`/`get_dashboard` are one path over one table) and match "the entity carries content **or** a
  path"; pure-directory (the folder *is* the default list, no rows) is a marginally cleaner git story but splits
  reads across FS + DB and needs default-override rules. Rows chosen; bootstrap reconciles rows to the files
  present.
- **SSE, entity-tagged (chosen)** vs WebSocket / vs coarse `data.changed` / vs polling — SSE is one-way
  server→client over plain HTTP (no protocol upgrade), which is exactly "notify the UI to refresh"; entity tags
  fall out of the effect runner for free, so targeted refetch costs nothing extra. WebSocket is overkill; polling
  is a backstop, not the primary.

## Consequences

- **Schema:** `dashboards` gains `source` + nullable `path`; `html` becomes nullable (null when file-backed). The
  applier/adapter enforces exactly one of `html`/`path` per `source`.
- **The dashboard content model changes** from full standalone page → fragment. The nine existing dashboards are
  converted once; `save_dashboard`'s stored shape becomes a fragment; ADR-013's "self-contained HTML page" wording
  is revised to "fragment rendered in the shell."
- **New repo files under version control:** `ui/shell.html`, `ui/app.js`, `ui/app.css`, `ui/dashboards/*.html` —
  and they must be **included in the published package** and read from the install location (read-only there).
- **New server capability:** an SSE route + an in-process change-event bus fed by `runEffects`; the runner gains a
  post-commit publish hook (small, at the one place writes commit).
- **`get_dashboard`/`/ui` gain a file-read path** (confined to `ui/dashboards/`), decoded/served like any content;
  path-traversal is structurally impossible for customs (always inline).
- The `overview` HTML-string seed in `seed/dashboards.ts` is **removed** in favor of `ui/dashboards/overview.html`.

## Migration plan (phased — behind the full gate; HTTP integration tests extend per phase)

1. **Shell + shared CSS + fragments** (`feat/ui-app-shell`): `ui/shell.html` + `ui/app.css` (styles lifted
   verbatim) + `ui/app.js` (menu + fragment loader); convert the existing dashboards to fragments served via
   `GET /api/dashboards/:name`; `/ui` → overview home; menu from `list_dashboards`. Still DB-stored.
2. **File-backed defaults + `source` discriminator** (`feat/ui-file-dashboards`): migration adds `source`/`path`;
   move the default dashboards to `ui/dashboards/*.html`; bootstrap registers them as `file`-backed rows (retire
   the seed string); `save_dashboard` stays `inline`; menu groups default vs custom by `source`; package includes
   `ui/`.
3. **SSE live-update** (`feat/ui-live-update`): the in-process change-event bus + the `runEffects` post-commit
   publish (entity tags); `GET /ui/events` SSE route; the shell subscribes and refetches sections by dependency.

## Action Items

1. [x] Review/accept this ADR.
2. [x] Phase 1 — app shell, shared `app.css`, fragment model, overview home, menu.
3. [x] Phase 2 — `source`/`path` discriminator, file-backed default dashboards, package the `ui/` files, custom
   submenu grouping.
4. [x] Phase 3 — SSE `/ui/events` + effect-runner change-event bus (entity-tagged) + shell dependency-refetch.
5. [x] Revise ADR-013's dashboard-model wording (revision note added, pointing here + to `docs/ui.md`); record
   the UI architecture (shell/fragments/source/SSE) and the `save_dashboard`-is-always-inline security invariant
   in its own `docs/ui.md` (extracted from `docs/architecture.md`, which now points to it); PLAN Phase 4
   web-frontend note.
6. [x] Convert the remaining default dashboards to file-backed fragments (`feat/new-default-templates`): all
   nine defaults — `overview`, `accounts`, `cards`, `categories`, `comparative`, `dashboards`, `pending`,
   `projections`, `tags` — now ship as `ui/dashboards/*.html`, auto-registered as `source: 'file'` rows by
   bootstrap's directory scan. Follow-up tracked separately: lift the CSS components duplicated across
   fragments (toast, modal, panel, form, kpi, spinner, loading-overlay) into `ui/app.css`
   ([#164](https://github.com/RafaelFCarneiro/fintrack/issues/164)).
7. [x] Pin version + SRI for the Flatpickr and Font Awesome CDN includes in `ui/shell.html`
   (`fix/pin-shell-cdn-assets`), matching Chart.js's existing pattern; Google Fonts documented as the one
   intentional exception (its CSS2 API response varies by requesting User-Agent, so there's no single fixed
   body to hash). Closes [#165](https://github.com/RafaelFCarneiro/fintrack/issues/165).

Each phase is feature-sized (schema and/or a new server capability, many files) → independent verification
subagent per diff.
