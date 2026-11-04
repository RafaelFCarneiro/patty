# Feature Design 002: Localized default categories (i18n)

**Type:** Feature design (not an ADR — a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Done · **PR:** [#24](https://github.com/RafaelFCarneiro/fintrack/pull/24) · **Branch:** `feat/category-i18n` ·
**Date:** 2026-06-17 (revised 2026-06-19) · Governed by **ADR-008** (seed isolation) and **ADR-009** (localized
content on the entity). The durable invariants land in `docs/architecture.md` when implemented.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

The 15 seeded default categories started out in **Portuguese** (`Alimentação`, `Transporte`, `Salário`, …).
Users may speak Spanish or English, so the default taxonomy should appear in the user's language while
preserving today's behaviour: a ready-made set of categories and merchant auto-classification.

Three facts make this tractable:

1. **Identity is a stable slug, not the name.** Default categories have slug IDs (`cat-food`, …).
2. **Classification is ID-based.** `merchant_category` maps a merchant key to a `category_id` (the slug),
   never to a display name. Localizing the **display name** cannot break classification.
3. **Seed is optional (ADR-008).** Default categories, currencies, and merchant rules are quality-of-life
   pre-setup; the domain must run on an empty DB. So the categories — and therefore *their translations* —
   are dynamic, optional content, not fixed UI chrome.

Fact 3 reshaped the design after a first implementation. Category names are **dynamic content with a
lifecycle** (created, renamed, deleted, possibly user-made), not static labels. Localizing them through a
translation **catalog** (a slug-keyed map in `logic/`) was the wrong tool: it created a two-class
`i18n_key`-set-vs-literal system and coupled the domain's name resolution to seed slugs. ADR-009 corrects this —
**localized names travel with the entity, as data.**

## Decision

1. **Seed is isolated under the db diplomat (ADR-008).** Currencies, default categories, and default merchant
   rules live in `src/diplomat/db/seed/` (`currencies.ts`, `categories.ts`, `merchant-rules.ts`), consumed only
   by `bootstrap.ts`. The domain never imports seed. Seed-only types — `DefaultCategoryId` and the
   `MerchantRule` shape — live in `seed/`, **not** `models/`. `models/Category` keeps a generic `Id`.
2. **The canonical seed is English** (default locale = `en`). Default category slug IDs are English
   (`cat-food`, `cat-transport`, …, `cat-other`); each row's required canonical `name` is English. The
   Portuguese/Spanish names become per-row seed data (Decision 3).
3. **Localized names live on the category row (ADR-009).** A category carries a required canonical **`name`**
   (always-present fallback) plus an optional **`names`** JSON column — `{"pt":"Alimentação","es":"Comida"}`,
   nullable. Read-time resolution is one uniform rule: **`displayName = names?.[locale] ?? name`**. A user
   category has `name` only (`names` null); a seeded category ships `name` = English + `names` = `{ pt, es }`.
   The `i18n_key` column and the `logic/i18n` catalog are **removed**; seeded translations are authored as the
   `names` values in `diplomat/db/seed/categories.ts`. Switching locale reflows names with no migration.
4. **Locale preference is AI-determined, stored, env-overridable, `en` cold-start.** A single-row **`settings`**
   table holds `locale` (`pt | es | en`) + `locale_source` (`default | inferred | explicit`) — this is *user
   state*, not seed. The **AI agent is the primary setter**: it infers the user's language and calls
   **`set_locale`**. `FINTRACK_LOCALE` overrides at startup. Resolution: `FINTRACK_LOCALE ?? settings.locale ??
   'en'`. Two guardrails (in the `set_locale` tool description):
   - **Anti-churn:** switch only on a *clear, sustained* language change — not isolated words, merchant names,
     or proper nouns. Don't oscillate.
   - **Respect explicit choice:** if `locale_source = explicit`, the agent does not silently auto-switch away.
     `get_preferences` exposes locale + source.
5. **Name resolution honours the active locale, tolerantly.** `resolveByName` for categories matches the active
   locale's name first, then the canonical `name` and any other-locale names present on the row (so a pt-locale
   user saying "food" still resolves). Ambiguity rules unchanged.
6. **Merchant rules are multilingual, additive, and seed (ADR-008).** Classification matches a normalized
   merchant **key** as a substring of the description (`description LIKE '%key%'`), so an English-only seed
   gives pt/es users *zero* hits (`FARMÁCIA`, `IFOOD`, `ALUGUEL` match nothing). The seed is the **union** of a
   language-agnostic brand pack plus `en`/`pt`/`es` keyword packs, all targeting English category slugs and
   loaded for every user (locale drives display, never which rules apply). The `MerchantRule` shape +
   `DEFAULT_MERCHANT_RULES` live in `diplomat/db/seed/merchant-rules.ts`; keys are re-normalized via
   `logic/merchant.ts#normalizeMerchant` and deduped by `(key, category)` at seed time. Authoring discipline:
   distinctive 4+ char keys; avoid short tokens that embed in unrelated words (`gas` ⊂ `gasolina`, `tax` ⊂
   `taxi`, `bar` ⊂ `embarque`); when a specific key must beat a generic one, add both — the matcher's
   longer-key tiebreak resolves it (`uber eats`→food over `uber`→transport).
7. **Classification logic is untouched.** Rules reference slugs and the matching algorithm is unchanged; only
   the seed *data* spans en/pt/es. Display localization never touches rules.

## Scope / out of scope

- **In:** seed isolation under `diplomat/db/seed/` (ADR-008); English-canonical seed (English slug IDs + English
  canonical `name`); localized names on the category row via a JSON `names` column + `names?.[locale] ?? name`
  resolution (ADR-009); multilingual additive merchant rules (brand + en/pt/es) in `seed/merchant-rules.ts`;
  `settings` table + AI-driven locale (`set_locale` with anti-churn + explicit-override guardrails,
  env-overridable, default en); locale-aware `resolveByName`; `set_locale`/`get_preferences` tools; a manual
  `scripts/reset-local-db.sh` (clean slate — **no** remap migration).
- **Out:** a translation **catalog** for category names (superseded — that's for chrome, not content);
  **locale-gated** merchant packs (we always load all); localizing **sub-categories**, **tags**, or
  user-created categories; localizing tool descriptions / error messages / currency names; RTL or pluralization
  machinery. Adding a locale is data-only (author `names` on seed rows + a `<locale>` merchant pack).

## Options Considered

### Option A — Localized names on the entity (JSON `names` column) — **chosen** (ADR-009)
**Pros:** one uniform resolution rule across seeded and user categories; no catalog and no domain↔seed coupling;
seeded translations are just seed data; additive (a new locale is data only); no join.
**Cons:** search-by-localized-name uses `json_extract`; a name absent for the active locale falls back to the
canonical `name` (acceptable).

### Option B — Translation catalog keyed by slug (`i18n_key` + `logic/i18n` map) — *superseded*
**Pros:** translations in one version-controlled map; no per-row storage.
**Cons:** wrong pattern for dynamic content; two-class `i18n_key`-set-vs-literal system; couples domain
resolution to seed slugs (violates ADR-008). This was the first implementation; ADR-009 replaces it.

### Option C — Separate `category_translations` table
**Pros:** normalized; clean cross-locale name search; unlimited locales.
**Cons:** a join on every category read + a migration to seed translations, for a small read-by-id set. Heavier
than the JSON column with no current need; revisit only if cross-locale name search becomes a hard requirement.

## Consequences

- **Seed relocates (ADR-008):** `bootstrap.ts` becomes pure "migrate + seed"; currencies, categories, and
  merchant rules move to `diplomat/db/seed/`. `DefaultCategoryId` and `MerchantRule` move out of `models/` into
  `seed/`. New invariant: every feature works on an unseeded DB (with a test).
- **Catalog deleted (ADR-009):** `logic/i18n.ts` (category translations) is removed; its strings become the
  `names` values on the seeded category rows in `diplomat/db/seed/categories.ts`.
- **Schema/migration:** drop `categories.i18n_key`; add `categories.names` (JSON, nullable); keep `name` as the
  required canonical fallback. Add the single-row `settings` table (`locale`, `locale_source`).
- **Resolution simplifies:** the category adapter/controller resolves `names?.[locale] ?? name` over the row's
  own data — pure, no catalog import, no seed dependency. The `i18n_key`-null-vs-set distinction disappears;
  user and default categories differ only in whether `names` is populated.
- **AI-driven locale:** `set_locale` detects the language and switches; `get_preferences` reads it. Cold-start
  `en`; on the first pt/es message the agent flips and `list_categories` reflows.
- **MCP surface:** `set_locale` / `get_preferences`; `list_categories` returns locale-resolved names;
  `create_category` for user categories is unchanged (literal `name`, `names` null). Documented in
  `docs/mcp-tools.md`.
- **Clean-slate, no remap migration.** No production data exists. We do **not** rewrite FKs; the English seed
  applies to a fresh DB. The existing dev DB is reset out of band via the manual `scripts/reset-local-db.sh`
  (deletes `fintrack.db` + `-wal`/`-shm`). **Dropping the DB is an explicit manual dev convenience — never a
  default pattern, never wired into `dev`/`test`/CI, never an automated migration.**
- **Invariant:** identity is the slug/id; display name is `names?.[locale] ?? name`; code and merchant rules key
  on the id, never a localized name.
- **Diplomatic blast radius:** `diplomat/db/seed/` (data + seed-only types) + a `settings` repo + read-time
  resolution at the category adapter/controller + two small tools. No change to classification logic,
  transactions, or the domain core.

---

## Implementation prompt

> Hand this section to a coding agent to build the feature. The design above is the source of truth; **read
> ADR-008 and ADR-009 first** (`docs/adr/008-*`, `docs/adr/009-*`). Work on branch **`feat/category-i18n`** —
> do **not** create a new branch; `git fetch && git rebase origin/main` first. NOTE: a prior cut built the
> superseded `i18n_key` + `logic/i18n` catalog with seed types in `models/`; this revision **replaces** that —
> expect to delete and move code, not just add.

**Before coding**, also read: `CLAUDE.md`, `docs/architecture.md`, `docs/canonical/diplomatic-architecture.md`,
`docs/canonical/code-style.md`, `docs/canonical/code-quality.md`. Skim `src/diplomat/db/schema.ts`, `src/diplomat/db/bootstrap.ts`,
`src/models/category.ts`, `src/diplomat/db/repos/categories.ts`, `src/controllers/categories.ts`,
`src/controllers/resolve.ts`, `src/config.ts`, `src/diplomat/mcp/server.ts`.

### Steps

1. **Seed isolation (ADR-008).** Create `src/diplomat/db/seed/{currencies,categories,merchantRules}.ts` and move
   `CURRENCIES`, `CATEGORIES`, and `DEFAULT_MERCHANT_RULES` out of `bootstrap.ts` into them. Move
   `DefaultCategoryId` and the `MerchantRule` shape out of `models/` into `seed/`. `bootstrap.ts` becomes
   migrate + invoke seed modules. Nothing outside `diplomat/db` imports `seed/`.
2. **English-canonical seed.** Seeded categories use English slug IDs and an English canonical `name`; their
   pt/es names are authored as each row's `names` map (step 3) in `seed/categories.ts`.
3. **Localized names on the entity (ADR-009).** Schema: **drop** `categories.i18n_key`; **add**
   `categories.names` (JSON, nullable); keep `name` required. Generate the migration. **Delete** `logic/i18n.ts`
   (category catalog). Read-time resolution at the category adapter/controller: `displayName = names?.[locale]
   ?? name`. `list_categories` returns active-locale names; user categories show literal `name`; switching
   locale reflows with no migration.
4. **Multilingual additive merchant rules (ADR-008).** In `seed/merchant-rules.ts`: `MerchantRule` shape +
   `DEFAULT_MERCHANT_RULES` (brand + `en`/`pt`/`es` sections), targeting `DefaultCategoryId`. `seedMerchantRules`
   normalizes every key via `normalizeMerchant` and dedupes by `(key, category)` before insert; all packs load
   for every user (not locale-gated). Authoring discipline: distinctive 4+ char keys; avoid short tokens that
   embed in unrelated words; add both keys when a specific must beat a generic and rely on the longer-key
   tiebreak.
5. **Locale** (`config.ts` + `settings` table): single-row `settings` holding `locale` (`pt|es|en`) and
   `locale_source` (`default|inferred|explicit`); small repo. `FINTRACK_LOCALE` overrides; effective locale =
   `env ?? settings.locale ?? 'en'`. **`set_locale`** (writes locale + source) with the two guardrails in its
   description — (a) anti-churn; (b) respect `explicit`. Agent calls mark `inferred`; a direct user request
   marks `explicit`. **`get_preferences`** exposes locale + source.
6. **Locale-aware `resolveByName`** (categories): match the active-locale name first, then the canonical `name`
   and other-locale names on the row. Keep existing ambiguity semantics.
7. **Classification logic untouched:** the matching algorithm is unchanged and rules reference slugs only; only
   the seed *data* spans pt/es (step 4).

### Tests
- **Unit:** `names?.[locale] ?? name` resolution — locale hit, fallback to canonical, user category (no `names`).
- **Integration** (in-process libSQL): fresh DB has English default IDs (`cat-food`, …) with `names` set; `en` →
  `list_categories` English; `set_locale('es')` → Spanish names, ids unchanged; `resolveByName` resolves by
  active-locale name + a cross-locale name; user category shows literal `name`; an `explicit` locale is not
  auto-overwritten by a later inferred set.
- **Multilingual classification** (in-process libSQL): a pt description (e.g. `FARMÁCIA SÃO JOÃO`) classifies to
  `cat-health` and an es one (e.g. `GASOLINERA REPSOL`) to `cat-transport`. Optionally assert the seed has no
  `(key)`→multiple-category conflict.
- **Empty-DB (ADR-008):** a representative tool works against an unseeded DB.
- **Gate:** `npm run typecheck && npm test && npm run test:integration && npm run build`.

### Invariants — do not break
- **Seed isolation (ADR-008):** seed lives only in `diplomat/db/seed/`; the domain (`models/`/`logic/`/
  `controllers/`) never imports it; the app boots and works on an empty DB.
- **Identity is the slug/id**, never the localized name; merchant rules and code key on the id.
- **Localized content on the entity (ADR-009):** category names resolve via `names?.[locale] ?? name`; no
  translation catalog for content. (A catalog is only for chrome — out of scope here.)
- **Classification is unaffected** (slug-based; display-only localization).
- **English is canonical/default**; pt/es are per-row `names` data; cold-start locale `en`.
- **User categories/sub-categories/tags stay literal**; merchant packs are additive — load all of
  brands+en+pt+es for every user; do NOT locale-gate them.
- **No destructive DB ops in code** — no drop/reset/rename-FK migration; the reset is the manual script only.
- **AI-locale guardrails are part of the contract** (via `locale_source` + the `set_locale` description).
- **Diplomatic layering**: seed in `diplomat/db/seed/`; `settings` repo in `diplomat/db`; resolution at the
  adapter/controller boundary; constants over literals (locale zod enum `.enum.*`).
- **Docs in the same change**: `docs/mcp-tools.md` (`set_locale`/`get_preferences`; `list_categories` is
  locale-resolved), `docs/architecture.md` (seed `seed/` location + dependency row + empty-DB invariant;
  `categories.names`; `settings`; identity-vs-name invariant), `CLAUDE.md` data conventions. Leave the rest of
  this design doc as-is — **except** update the **Implementation status** header line (→ `Done` in the commit
  the PR merges; `Blocked` + reason if stuck).

### Finish
Conventional Commits (`feat(categories): seed isolation + localized names on the entity` + `test:`/`docs:`),
`git push -u origin feat/category-i18n`, open a PR targeting `main`. Do not merge; after CI, reply to review
threads with the resolving SHA.
