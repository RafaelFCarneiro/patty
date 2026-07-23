# Feature Design 013: Dashboard id-normalization + delete + rename

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress (Phase 1 done) · **Date:** 2026-07-22 · Extends the dashboard domain (**ADR-013**).
Follows the idempotent-delete pattern of `deleteTag` and the versioned-entity-with-unique-secondary-key applier
pattern of `tagApplier`/`billApplier`.

**Delivered as three sequential PRs, each its own branch off the latest `main`** (suggested names):
`feat/dashboard-id-normalization` (Phase 1) → `feat/dashboard-delete` (Phase 2) → `feat/dashboard-rename`
(Phase 3). Phase 1 is behavior-preserving groundwork; 2 and 3 are additive and each depend on 1.

> **Implementation status** tracks delivery, distinct from the design's acceptance:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line.

## Context

Dashboards (ADR-013) can be **saved**, **listed**, and **fetched**, but not **deleted** or **renamed** — a
lifecycle gap. Two related shortcomings today:

1. **No delete / no rename.** Dashboards accumulate with no way to remove one, and a name can only be changed by
   deleting and re-creating (which loses identity and is a two-step dance).
2. **`dashboards` keys on `name` (PK), so `dashboardApplier` is hand-written** — the one applier that keys its
   `insert`/`update`/`delete` on `name` and catches `SQLITE_CONSTRAINT_PRIMARYKEY` on the name collision, rather
   than using the generic `versionedTableApplier`. It is a wholly bespoke third applier shape (alongside the
   `id`/`version` family and the `id`/`version`-less link tables).

The root cause of both is that **`name` is doing double duty as the surrogate identity and the human handle.**
A rename is impossible without a stable identity separate from the name; and the name-as-PK is why the applier
can't be generic. A surrogate `id` fixes both at once — which is what makes the `id` genuinely load-bearing here,
not merely tidier.

Current shape (grounded):

- `dashboards`: `name PK, html, updatedAt, version` (`schema.ts`).
- `models/dashboard.ts`: `Dashboard { name, html, updatedAt }` (wire), `DashboardEntity` adds `version`,
  `DASHBOARD_ENTITY_TAG`, `dashboardErrors.notFound/invalidHtml`.
- `controllers/dashboards.ts`: `saveDashboard` (upsert by name via `findVersionByName`), `listDashboards`,
  `getDashboard`. No delete, no rename.
- `DashboardsRepo`: `get(name)`, `findVersionByName(name)`, `list()` (read-only, per ADR-021).
- `dashboardApplier`: hand-written, `insert`/`update`/`delete` keyed on `name`; `delete` mechanics already exist
  (there is just no controller flow or tool that emits a delete).
- Surfaces: `name` is the `/ui/:name` path segment and the `/api` lookup key; the AI UX references a dashboard by
  name ("show my spending dashboard").

## Decision

Add a surrogate `id`, make the applier generic, and add the two missing lifecycle flows.

### 1. Normalize to a surrogate `id` — `name` stays the human handle

- **Schema (migration `0011`):** add `id TEXT PRIMARY KEY`; `name` becomes `TEXT NOT NULL UNIQUE` (was PK);
  `html`/`updatedAt`/`version` unchanged. Backfill existing rows with `crypto.randomUUID()` (single-user,
  local-first — a handful of rows).
- **`id` is internal, exactly like `version`.** It never appears on the wire/out `Dashboard` shape and is never
  a tool argument. **The `/ui/:name` URL and every `/api`/MCP surface are unchanged** — they keep resolving by
  `name`. This is the key property: the migration is invisible to every consumer. `name` **must stay `UNIQUE`**,
  because it remains the handle the surface and the user reference.
- **`/ui/:name` must keep working, unaffected — this is a hard requirement.** Grounded: the `/ui/:name`
  handler (`diplomat/http/routes.ts:892`) and `GET /api/dashboards/:name` (`routes.ts:820`) both route through
  `getDashboard(deps, name)` → `dashboards.get(name)` (`WHERE name = ?`) and serve `dashboard.html`. Phase 1
  leaves `get(name)`, the `name` lookup, and the `html` column **untouched**, so both paths are structurally
  unaffected — the `id` never enters this route. Any change that would make `getDashboard`/`get(name)` depend on
  `id` is out of scope and disallowed. A regression test guards this (Testing, below).

### 2. The applier becomes `tagApplier`-shaped — not a plain one-liner

Because `name` stays `UNIQUE`, a concurrent first save of the same **new** name mints two different ids, both
insert, and the second raises `SQLITE_CONSTRAINT_UNIQUE` on `name` — which `versionedTableApplier`'s id-scoped
`onConflictDoNothing({ target: table.id })` does **not** swallow. So:

```
export const dashboardApplier: EntityApplier = {
  ...versionedTableApplier(dashboards),
  insert: async (tx, model) => {
    try { return await versionedTableApplier(dashboards).insert(tx, model); }
    catch (cause) { if (isUniqueConstraintViolation(cause)) throw new VersionConflict(); throw cause; }
  },
};
```

This is **structurally identical to `tagApplier`** (`tags.name` UNIQUE) and reuses the shared
`isUniqueConstraintViolation` (`diplomat/db/sqliteErrors.ts`). Net: dashboards leaves the bespoke-third-pattern
bucket and joins the tags/bills "versioned entity with a unique secondary key" family. `update`/`delete` are the
generic `versionedTableApplier` mechanics (keyed on `id`+`version`). The old `isPrimaryKeyConstraintViolation`
path is deleted (a fresh-uuid `id` never collides; the name collision is now a UNIQUE, not a PK, violation).

> **Honest scope note:** the promised payoff is "one fewer *wholly bespoke* applier," not "the applier
> disappears." Dashboards still needs the unique-name-conflict wrapper. The win is pattern consolidation +
> reuse of shared machinery, and — decisively — that the `id` is what makes rename possible at all.

### 3. Reads carry the ref; `saveDashboard` and both new flows resolve name → id

- Replace `findVersionByName(name)` with **`findRefByName(name): { id, version } | null`** — save and delete need
  the `id` (to build an `update`/`delete` `Persistable`) plus the `version`, still without pulling the ~500 KB
  `html` on every save (the existing perf rationale holds).
- Add **`findByName(name): DashboardEntity | null`** (full row incl. `id`/`version`/`html`) for **rename**, which
  must re-emit the whole row under a new name (the generic `update` rewrites all non-`id`/`version` columns).
- `get(name)` (public `Dashboard`, no `id`) is unchanged.
- `adapters/dashboards.ts`: `dbToModel` continues to strip `id`; add a `dbToEntity` (includes `id`/`version`) for
  the ref/full reads. `DashboardEntity` gains `id` (internal — `.describe('internal; never on wire/out')`, like
  `version`).

### 4. `saveDashboard` — unchanged behavior, mints an `id` on insert

`saveDashboard` still upserts by name: `findRefByName(name)` → `null` builds an `insert` (minting
`id: deps.newId()`), otherwise an `update` carrying `{ id, version }`. Content-save semantics are unchanged; only
the internal shape of the `Persistable` gains `id`.

### 5. `delete_dashboard` — idempotent, by name

`deleteDashboard(deps, name)` mirrors `deleteTag` (adapted to the `name` handle):

```
const ref = await deps.dashboards.findRefByName(name);
if (!ref) return ok({ persist: [], response: { deleted: false } });   // idempotent, no write
return ok({ persist: [persistence.remove({ entity: DASHBOARD_ENTITY_TAG, id: ref.id, version: ref.version })],
           response: { deleted: true } });
```

MCP tool `delete_dashboard { name }` → `{ deleted: boolean }`. Unknown name is **not** an error — it returns
`{ deleted: false }` on an empty batch (same idempotent-by-design shape as `delete_tag`).

### 6. `rename_dashboard` — the capability the `id` unlocks

`renameDashboard(deps, name, newName)`:

1. `findByName(name)` → not found → `dashboardErrors.notFound(name)`.
2. Guard `newName` is free: `findRefByName(newName)` must be `null`, else `dashboardErrors.duplicateName(newName)`
   (a new error, mirroring `tags`' `duplicate_name` — a clean expected failure rather than relying on the
   applier's unique-conflict retry, which would surface as a generic `conflict`).
3. Emit `update({ entity: DASHBOARD_ENTITY_TAG, model: { ...entity, name: newName, updatedAt: clock() } })` —
   same `id`, same `html`, new `name`, bumped `updatedAt`, carrying the read `version`.

MCP tool `rename_dashboard { name, newName }` → the renamed `Dashboard`. The `/ui/:newName` URL now serves it;
`/ui/:name` 404s (expected — the handle moved). Reading the full row (incl. `html`) for a rename is acceptable:
rename is rare, unlike save.

## Options Considered

### A — Keep `name` as PK; add delete only (rejected for the chosen scope)
Delete alone needs no migration (the applier's `delete` already works by name). But it leaves the bespoke applier
and makes rename impossible (name-PK rename = delete + re-insert, new identity). Viable if rename weren't wanted;
the chosen scope wants it.

### B — Surrogate `id`, `name` UNIQUE, generic-ish applier + delete + rename (chosen)
`id` becomes genuinely load-bearing (enables rename), the applier joins the tags/bills family, and the surface is
untouched (`id` internal). Cost: a PK-changing migration + a full-row read on rename.

### C — Composite/natural-key rename via `save` under a new name (rejected)
"Rename" by saving the html under a new name creates a *second* dashboard and orphans the first — not a rename.
Preserving identity across a name change is exactly what the surrogate `id` is for.

## Docs to update (same change)

- `docs/architecture.md` § Relational schema — `dashboards` row shape (`id` PK, `name` UNIQUE).
- `docs/write-path.md` — the `dashboardApplier` mention (hand-written, keys on `name`) → now
  `versionedTableApplier` + unique-name-conflict wrapper, `tagApplier`-shaped; and the `dashboards`-keys-on-`name`
  asides in the `versionedTableApplier` bullet.
- `docs/mcp-tools.md` — `delete_dashboard`, `rename_dashboard` (schema, error codes, examples).
- ADR-013 gets a short amendment note (dashboards gained a surrogate `id`; `name` is now a unique handle, not the
  PK) — an evolution of, not a contradiction to, the ADR.
- This doc's Implementation status → `In progress` / `Done`.

## Testing

- **Migration**: existing rows backfill a stable `id`; `name` uniqueness enforced; save/list/get behave
  identically post-migration (behavior-preserving).
- **`/ui/:name` regression (hard requirement)**: an HTTP-level integration test (Fastify `inject`) — save a
  dashboard, `GET /ui/:name` → `200` + the exact `html`, and `GET /api/dashboards/:name` → the `Dashboard` — must
  pass **unchanged before and after Phase 1**. After Phase 3, `GET /ui/:newName` serves the renamed dashboard and
  `GET /ui/:oldName` → `404`. This coverage already exists (`test/integration/http/dashboards.test.ts`, added
  alongside the original `/ui` surface and closing [#21](https://github.com/RafaelFCarneiro/fintrack/issues/21));
  Phase 1's job is to confirm it keeps passing unchanged, not to add it.
- **Applier**: concurrent same-new-name save → unique-name conflict → `VersionConflict` → retry resolves to an
  update of the winner (mirror `tagApplier`'s race test).
- **Delete**: present → `{ deleted: true }` and the row is gone; unknown name → `{ deleted: false }`, no write;
  version-conflict path retries.
- **Rename**: success (id preserved, `/ui/:newName` serves, `/ui/:name` 404s); `newName` collides →
  `duplicate_name`; `name` missing → `unknown_dashboard`.
- **saveDashboard**: insert mints an `id`; update preserves it.

## Implementation prompt

Implement in three phases, each its own PR behind the full gate. Read `docs/write-path.md` before touching the
applier or any flow, and `docs/architecture.md` § Write path guardrails.

### Phase 1 — Normalize to `id` (behavior-preserving, no new tools)
Migration `0011` (add `id` PK, `name` UNIQUE, backfill UUIDs). `DashboardEntity` gains internal `id`;
`adapters/dashboards.ts` gains `dbToEntity`. Repo: `findVersionByName` → `findRefByName(name): {id, version}`,
add `findByName(name): DashboardEntity`. `saveDashboard` mints `id` on insert / carries `{id, version}` on
update. `dashboardApplier` → `{ ...versionedTableApplier(dashboards), insert: <unique-name-conflict wrapper> }`;
delete the `isPrimaryKeyConstraintViolation` path. Update `docs/architecture.md` schema + `docs/write-path.md`.
**Confirm the existing `/ui/:name` + `/api/dashboards/:name` regression test (Testing, above) still passes
unchanged — the hard requirement that the UI route is unaffected. `get(name)`, the `name` lookup, and the `html`
column must not be touched.**

### Phase 2 — `delete_dashboard`
`deleteDashboard(deps, name)` (mirror `deleteTag`, idempotent) + the `delete_dashboard` MCP tool + `docs/mcp-tools.md`.

### Phase 3 — `rename_dashboard`
Add `dashboardErrors.duplicateName`; `renameDashboard(deps, name, newName)` (not-found + duplicate-name guards +
version-guarded `update`) + the `rename_dashboard` MCP tool + `docs/mcp-tools.md`. ADR-013 amendment note.

### Finish (every push, every phase)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result. Phase 1 touches the schema and an applier, so
it is feature-sized — dispatch an independent verification subagent on its diff before pushing.
