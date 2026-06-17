# ADR-009: Localized default categories (i18n)

**Status:** Accepted · **Date:** 2026-06-17 · Refines the category model in `docs/architecture.md`.

## Context

The 15 seeded default categories are written in **Portuguese** (`Alimentação`, `Transporte`, `Salário`, …).
FinTrack's users may speak Spanish or English, so the default taxonomy should appear in the user's language
while preserving today's behaviour: a ready-made set of categories and merchant auto-classification.

Two facts about the current model make this tractable:

1. **Identity is a stable slug, not the name.** Default categories have slug IDs (`cat-alimentacao`).
2. **Classification is ID-based.** `merchant_category` maps a merchant key to a `category_id` (the slug),
   never to a display name. So localizing the **display name** cannot break classification.

Localization is therefore purely a **display + name-resolution** concern, not a data-model upheaval. The open
questions are: where the locale preference lives, and whether names are localized once at seed time or
resolved per-locale at read time.

## Decision

1. **Locale preference is stored, with an env override, default `en`.** A single-row **`settings`** table holds
   the user's `locale` (`pt | es | en`). `FINTRACK_LOCALE` overrides it at startup (CI/scripts). Default is
   **English** for the broadest audience. A `set_preferences` / `get_preferences` tool reads/writes it.
2. **Default categories carry an i18n key; names resolve at read time.** Add a nullable **`i18n_key`** column
   to `categories`. Default (seeded) categories set it (e.g. `category.alimentacao`); user-created categories
   leave it `null` and keep their literal `name`. On read, the display name is:
   `i18n_key ? translate(i18n_key, locale) : name` — so **switching locale instantly reflows** all default
   category names, with no data migration. The seeded `name` column stays as the fallback when a translation
   is missing.
3. **Translations are pure data in `logic/`.** A `logic/i18n` map provides `pt | es | en` strings for the ~15
   default category keys (and is the home for any future localized strings). Pure, unit-testable, no I/O.
4. **Name resolution honours the active locale, tolerantly.** `resolveByName` for categories matches the
   user's-locale display names first; for robustness it also accepts the literal seeded name and other-locale
   synonyms of the same key (so an English-locale user saying "alimentação" still resolves). Ambiguity rules
   are unchanged.
5. **Classification is untouched.** Merchant rules continue to reference category **slugs**; localization
   never touches them.

## Scope / out of scope

- **In:** `settings` table + locale preference (env-overridable, default en); `i18n_key` on categories;
  read-time name resolution; pt/es/en translations for the default categories; locale-aware `resolveByName`;
  `set_preferences`/`get_preferences` tools.
- **Out:** localizing **sub-categories**, **tags**, or user-created categories (they are user literals);
  localizing tool descriptions / error messages / currency names; right-to-left or pluralization machinery.
  Adding locales beyond pt/es/en is a data-only follow-up.

## Options Considered

### Option A — read-time resolution by key + locale — **chosen**
**Pros:** locale switch reflows default names live with zero migration; one source of truth (the translations
map); default vs. user category is a clean `i18n_key is null` distinction.
**Cons:** every category read resolves a name (cheap: an in-memory map lookup at the adapter boundary).

### Option B — seed-time localization (names baked at first run)
**Pros:** simplest; no key column, no resolution step.
**Cons:** changing locale later does not rename existing default categories; re-seeding would clash with
user edits. Rejected — fails the "according to user preference" goal once the DB exists.

### Option C — fully separate localized name table (category_translations rows)
**Pros:** translations live in the DB; non-developers could edit them.
**Cons:** heavier (join on every read, migration to seed translations) for a fixed, ~15-row, developer-owned
set. The pure-data map (Option A) is lighter and version-controlled. Rejected for now.

## Consequences

- **Schema/migration:** add `categories.i18n_key text` (nullable); backfill the seeded categories' keys; add
  a `settings` table (single row: `locale`). Seed translations live in code, not the DB.
- **Default locale change:** new databases default to `en`; the seeded fallback `name` values should be the
  English strings (with pt/es in the translations map), so a fresh install reads naturally in English.
- **MCP surface:** `get_preferences` / `set_preferences` (locale); `list_categories` returns names already
  resolved to the active locale; `create_category` for user categories is unchanged (literal name, no key).
  Documented in `docs/mcp-tools.md`.
- **Invariant:** a category's **identity** is its id/slug; its **display name** is derived (for defaults) or
  literal (for user categories). Code and merchant rules key on the id, never the localized name.
- **Diplomatic blast radius:** a `settings` repo + `logic/i18n` map + read-time resolution in the category
  adapter/controller + two small tools. No change to classification, transactions, or the domain core.
