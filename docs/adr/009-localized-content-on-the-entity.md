# ADR-009: Localized content lives on the entity; i18n catalogs are for chrome only

**Status:** Accepted · **Date:** 2026-06-19 · Refines the category model in `docs/architecture.md`; depends on
ADR-008 (seed isolation). Supersedes the `i18n_key` + translation-map approach drafted in Feature Design 002.

## Context

Default categories must display in the user's language (pt/es/en) while the canonical identity stays a stable
slug. The first implementation localized category names with a **translation catalog**: a nullable `i18n_key`
column on `categories` pointing into a hardcoded `logic/i18n.ts` map of `key → { pt, es, en }`, resolved at
read time as `i18n_key ? translate(i18n_key, locale) : name`.

Two problems surfaced:

1. **Wrong tool for the data.** A translation catalog is the right pattern for **chrome** — UI labels, button
   text, error messages: static strings that always exist and have no lifecycle. Categories are the opposite:
   **dynamic content** with a lifecycle (created, renamed, deleted, and potentially user-made). Localizing
   dynamic content through a chrome-style catalog produces a two-class system (`i18n_key`-set vs. literal
   `name`) and an awkward resolution branch.
2. **The catalog couples the domain to seed.** The map is keyed by *seed* slugs and lives in `logic/`, so the
   domain's read-time name resolution depends on seed-specific keys — violating ADR-008 ("the domain must run
   on an empty DB; it must not depend on seed").

The insight: **localized names of a dynamic entity are data that should travel with the entity**, not entries
in a separate catalog.

## Decision

1. **Localized names live on the category row.** A category carries a required canonical **`name`** (the
   always-present fallback) plus an optional **`names`** map of locale → localized name, stored as a **JSON
   column** (`{"pt":"Alimentação","es":"Comida"}`, nullable).
2. **Resolution collapses to one uniform rule:** `displayName = names?.[locale] ?? name`. No catalog, no
   `i18n_key`, no two-class branch. A user category has `name` only (`names` null); a seeded category ships
   `name` = English + `names` = `{ pt, es }`.
3. **Seeded translations are seed data (ADR-008).** The pt/es names of default categories are authored in
   `diplomat/db/seed/categories.ts` as the rows' `names` values. `logic/i18n.ts` (the category catalog) is
   **deleted**. If seed is absent, there are no categories to translate — consistent with "translation is as
   optional as the seed it describes".
4. **`resolveByName` matches across present names + the canonical name** (active locale first, then fallback
   and any other-locale names on the row), preserving existing ambiguity semantics.
5. **Catalogs remain the right pattern for chrome.** If/when true UI chrome is localized (tool descriptions,
   error messages — currently out of scope), a static i18n catalog is the correct tool then. Content →
   on the entity; chrome → a catalog. The two are complementary, not competing.

## Options Considered

### Option A — Translation catalog keyed by slug (`i18n_key` + `logic/i18n.ts`) — *superseded*
| Dimension | Assessment |
|---|---|
| Fit for dynamic content | Poor (two-class system) |
| Domain/seed coupling | Couples domain resolution to seed slugs |
| Add a locale | Edit the code map |

**Pros:** translations version-controlled in one map; no per-row storage.
**Cons:** wrong pattern for entities with a lifecycle; user categories don't fit; domain depends on a
seed-keyed catalog (violates ADR-008).

### Option B — Localized names on the tuple, JSON `names` column — **chosen**
| Dimension | Assessment |
|---|---|
| Fit for dynamic content | Strong (names travel with the entity) |
| Domain/seed coupling | None (resolution reads the row; translations become seed data) |
| Add a locale | Data only — author `names` on seed rows |

**Pros:** one uniform resolution rule; user and seeded categories handled identically; deletes the catalog and
the `i18n_key` two-class system; additive (a new locale is pure data, no migration); no join.
**Cons:** searching by localized name uses `json_extract`; an out-of-locale name not present on the row falls
back to canonical `name` (acceptable).

### Option C — Separate `category_translations` table (id, category_id, locale, name)
**Pros:** normalized; clean cross-locale search-by-name; unlimited locales.
**Cons:** a join on every category read and a migration to seed translations, for a small, mostly read-by-id
set. Heavier than the JSON column without a current need. Revisit only if cross-locale name search becomes a
hard requirement.

## Trade-off Analysis

The decision turns on **what kind of thing a category name is**. Treating it as chrome (Option A) optimizes for
a fixed catalog but misfits dynamic, user-extensible content and drags a seed dependency into the domain.
Treating it as content on the entity (Option B) makes localization a property of the row — uniform across
seeded and user categories, and free of seed coupling. Option C is the "more correct" relational form but pays
a join + migration cost that a ~15–50-row, read-by-id set doesn't justify yet. JSON on the tuple is the right
weight for now and stays additive.

## Consequences

- **Schema/migration:** drop `categories.i18n_key`; add `categories.names` (JSON, nullable). `name` stays the
  required canonical fallback.
- **Delete the catalog:** `logic/i18n.ts` (category translations) is removed; its content moves to the `names`
  values in `diplomat/db/seed/categories.ts`.
- **Resolution simplifies:** the adapter/controller boundary resolves `names?.[locale] ?? name` — a trivial,
  pure step over the row's own data, with no catalog import and no seed dependency.
- **`resolveByName`** gains tolerance across the row's localized names + canonical name; ambiguity rules
  unchanged.
- **Uniform model:** the `i18n_key`-null-vs-set distinction disappears; user and default categories differ only
  in whether `names` is populated.
- **Invariant:** identity is the slug/id; the display name is `names?.[locale] ?? name`. Code and merchant
  rules key on the id, never a localized name.
- **Docs:** `docs/architecture.md` (the `names` column, the resolution rule, identity-vs-name invariant),
  `docs/mcp-tools.md` (`list_categories` returns locale-resolved names; `set_locale`/`get_preferences`
  unchanged), and Feature Design 002 rewritten to this model.

## Action Items

1. [ ] Schema: replace `categories.i18n_key` with a nullable JSON `names` column; generate the migration.
2. [ ] Author seeded category `names` (pt/es) in `diplomat/db/seed/categories.ts`; delete `logic/i18n.ts`.
3. [ ] Implement read-time resolution `names?.[locale] ?? name` at the category adapter/controller boundary.
4. [ ] Extend `resolveByName` to match localized names + canonical name.
5. [ ] Update `docs/architecture.md`, `docs/mcp-tools.md`, and Feature Design 002; refresh tests (resolution,
   fallback, cross-locale `resolveByName`, user-category literal name).
