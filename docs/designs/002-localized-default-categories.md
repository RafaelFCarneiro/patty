# Feature Design 002: Localized default categories (i18n)

**Type:** Feature design (not an ADR — a feature + technical assessment) · **Status:** Accepted ·
**Date:** 2026-06-17 · Refines the category model in `docs/architecture.md`. The durable invariants this
produces (category identity = slug; display name resolved per locale) land in `docs/architecture.md` when implemented.

## Context

The 15 seeded default categories are written in **Portuguese** (`Alimentação`, `Transporte`, `Salário`, …).
FinTrack's users may speak Spanish or English, so the default taxonomy should appear in the user's language
while preserving today's behaviour: a ready-made set of categories and merchant auto-classification.

Two facts about the current model make this tractable:

1. **Identity is a stable slug, not the name.** Default categories have slug IDs.
2. **Classification is ID-based.** `merchant_category` maps a merchant key to a `category_id` (the slug),
   never to a display name. So localizing the **display name** cannot break classification.

Localization is therefore purely a **display + name-resolution** concern, not a data-model upheaval. The open
questions are: where the locale preference lives, who sets it, whether names are localized once at seed time
or resolved per-locale at read time, and — since the default language is now English — what language the
**canonical seed** itself (slug IDs, fallback names, merchant rules) should be written in.

## Decision

1. **The canonical seed is English** (default locale = `en`). Default category **slug IDs are English**
   (`cat-food`, `cat-transport`, `cat-housing`, `cat-utilities`, `cat-health`, `cat-education`, `cat-leisure`,
   `cat-shopping`, `cat-subscriptions`, `cat-travel`, `cat-taxes`, `cat-salary`, `cat-extra-income`,
   `cat-investments`, `cat-other`); their stored fallback `name` is English; and the seeded **merchant rules
   are international/English** (e.g. `uber`, `amazon`, `netflix`, `spotify`, `walmart`, `pharmacy`,
   `supermarket`, …) referencing those English IDs. The current Portuguese strings move into the `pt`
   translations. *(Region-specific merchant packs — e.g. seeding BR merchants when locale is `pt` — are a
   noted future extension, see out of scope.)*
2. **Locale is AI-determined, stored, env-overridable, with an `en` cold-start.** A single-row **`settings`**
   table holds `locale` (`pt | es | en`) plus a `locale_source` (`default | inferred | explicit`). The **AI
   agent is the primary setter**: it infers the user's language from the conversation and calls **`set_locale`**
   to match. `FINTRACK_LOCALE` overrides at startup (testing/CI). Resolution:
   `FINTRACK_LOCALE ?? settings.locale ?? 'en'`. Two guardrails (in the `set_locale` tool description):
   - **Anti-churn:** switch only on a *clear, sustained* language change — not on isolated words, merchant
     names, or other proper nouns. Don't oscillate.
   - **Respect explicit choice:** if the user set the locale explicitly (`locale_source = explicit`), the agent
     does not silently auto-switch away from it. `get_preferences` exposes the current locale and source so
     the agent can reason about both.
3. **Default categories carry an i18n key; names resolve at read time.** Add a nullable **`i18n_key`** column
   to `categories`. Default (seeded) categories set it (the English slug doubles as the key, e.g. `cat-food`);
   user-created categories leave it `null` and keep their literal `name`. On read, the display name is:
   `i18n_key ? translate(i18n_key, locale) : name` — so **switching locale instantly reflows** all default
   category names, with no data migration. The seeded English `name` stays as the fallback when a translation
   is missing.
4. **Translations are pure data in `logic/`.** A `logic/i18n` map provides `pt | es | en` strings for the ~15
   default category keys (and is the home for any future localized strings). Pure, unit-testable, no I/O.
5. **Name resolution honours the active locale, tolerantly.** `resolveByName` for categories matches the
   active-locale display names first; for robustness it also accepts the English fallback and other-locale
   synonyms of the same key (so a pt-locale user saying "food" still resolves). Ambiguity rules are unchanged.
6. **Classification is untouched.** Merchant rules continue to reference category **slugs**; localization
   never touches them.

## Scope / out of scope

- **In:** English-canonical seed (English slug IDs, English fallback names, international merchant rules);
  a manual `scripts/reset-local-db.sh` to wipe the dev DB (clean slate — **no** remap migration); `settings`
  table + AI-driven locale (`set_locale` with anti-churn + explicit-override guardrails, env-overridable,
  default en); `i18n_key` on categories; read-time name resolution; pt/es/en translations for the default
  categories; locale-aware `resolveByName`; `set_locale`/`get_preferences` tools.
- **Out:** **region-specific merchant packs** (e.g. seeding BR merchants — ifood, 99, rappi — when locale is
  `pt`); localizing **sub-categories**, **tags**, or user-created categories (user literals); localizing tool
  descriptions / error messages / currency names; RTL or pluralization machinery. Adding locales beyond
  pt/es/en is a data-only follow-up.

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

- **English-canonical seed:** `bootstrap.ts` is rewritten so default categories use English slug IDs + English
  fallback names, and merchant rules are international and reference the new IDs. The Portuguese strings live
  only in the `pt` translations map.
- **Clean-slate, no remap migration.** There is no production data — the only existing database is a single
  local **dev/test** DB. So we do **not** rewrite foreign keys: the schema simply seeds the English IDs on a
  fresh DB. The existing dev DB is reset **out of band** via a manual `scripts/reset-local-db.sh` that deletes
  the local `fintrack.db` (and its `-wal`/`-shm` sidecars). **Dropping the DB is an explicit, manual dev
  convenience — never a default pattern, never wired into `dev`/`test`/CI, and never an automated migration.**
  This is acceptable precisely because the slug-ID change predates any real user data; it would NOT be an
  acceptable approach once production data exists (that would require the remap migration this design avoids).
- **Schema/migration:** add `categories.i18n_key text` (nullable; = the English slug for defaults); add a
  `settings` table (single row: `locale`, default `en`). Seed translations live in code, not the DB.
- **AI-driven locale:** the `set_locale` tool description tells the agent to detect the user's language and
  switch; `get_preferences` lets it read the current value. Cold-start is `en`; the agent flips to pt/es on
  the first message in that language, and `list_categories` immediately reflows.
- **MCP surface:** `set_locale` / `get_preferences`; `list_categories` returns names already resolved to the
  active locale; `create_category` for user categories is unchanged (literal name, no key). Documented in
  `docs/mcp-tools.md`.
- **Invariant:** a category's **identity** is its id/slug; its **display name** is derived (for defaults) or
  literal (for user categories). Code and merchant rules key on the id, never the localized name.
- **Diplomatic blast radius:** a `settings` repo + `logic/i18n` map + read-time resolution in the category
  adapter/controller + two small tools + the English seed rewrite (clean slate, no remap). No change to
  classification logic, transactions, or the domain core.

---

## Implementation prompt

> Hand this section to a coding agent to build the feature. The design above is the source of truth; this is
> the execution guide. Work on branch **`feat/category-i18n`** — do **not** create a new branch;
> `git fetch && git rebase origin/main` first.

**Before coding**, also read: `CLAUDE.md`, `docs/architecture.md`, `docs/diplomatic-architecture.md`,
`docs/code-style.md`, `docs/code-quality.md`. Skim the current shape of `src/diplomat/db/schema.ts`,
`src/diplomat/db/bootstrap.ts` (seeded categories + merchant rules), `src/models/category.ts`,
`src/diplomat/db/repos/categories.ts`, `src/controllers/categories.ts`, `src/controllers/resolve.ts`,
`src/config.ts`, `src/diplomat/mcp/server.ts`.

### Steps

1. **English-canonical seed** (`bootstrap.ts`): default categories use English slug IDs (`cat-food`,
   `cat-transport`, `cat-housing`, `cat-utilities`, `cat-health`, `cat-education`, `cat-leisure`,
   `cat-shopping`, `cat-subscriptions`, `cat-travel`, `cat-taxes`, `cat-salary`, `cat-extra-income`,
   `cat-investments`, `cat-other`), English fallback names, each with its `i18n_key` (= the English slug);
   merchant rules become international/English (`uber`, `amazon`, `netflix`, `spotify`, `walmart`, `pharmacy`,
   `supermarket`, `restaurant`, `gas`, `parking`, `rent`, …) referencing the new IDs. Move the current
   Portuguese strings into the `pt` translations map.
2. **Clean slate — NO remap migration.** No production data exists. Do **not** rename slug IDs or rewrite FKs;
   the English seed applies to a fresh DB. The manual `scripts/reset-local-db.sh` already exists — do not
   recreate it, and never wire any drop/reset into `dev`/`test`/CI.
3. **`i18n_key` column** (`schema.ts` + migration): nullable; defaults set it, user categories leave it `null`.
4. **Locale** (`config.ts` + `settings` table): single-row `settings` holding `locale` (`pt|es|en`) and
   `locale_source` (`default|inferred|explicit`); small repo. `FINTRACK_LOCALE` env overrides; effective locale
   = `env ?? settings.locale ?? 'en'`. **`set_locale`** tool (writes locale + source) whose description carries
   two guardrails — (a) anti-churn: switch only on a clear, sustained language change, not isolated words /
   merchant names / proper nouns; (b) respect explicit: if `locale_source` is `explicit`, don't auto-switch
   away. Agent calls mark `inferred`; a direct user request marks `explicit`. **`get_preferences`** exposes
   locale + source.
5. **Translations** (`logic/i18n`): pure `key → { pt, es, en }` map for the ~15 default keys. Unit-tested, no I/O.
6. **Read-time resolution** (category adapter/controller): display name = `i18n_key ? translate(i18n_key, locale) : name`.
   `list_categories` returns active-locale names; user categories show literal `name`; switching locale reflows.
7. **Locale-aware `resolveByName`** (categories): match active-locale names first; also accept the English
   fallback and other-locale synonyms of the same key. Keep existing ambiguity semantics.
8. **Classification untouched:** merchant rules reference slugs only.

### Tests
- **Unit** (`logic/i18n`): every default key has pt/es/en; `translate` + fallback.
- **Integration** (in-process libSQL): fresh DB has English default IDs (`cat-food`, …) with `i18n_key` set;
  `en` → `list_categories` English; `set_locale('es')` → Spanish names, ids unchanged; `resolveByName` resolves
  by active-locale name + a cross-locale synonym; user category shows literal name; an `explicit` locale is not
  auto-overwritten by a later inferred set.
- **Gate:** `npm run typecheck && npm test && npm run test:integration && npm run build`.

### Invariants — do not break
- **Identity is the slug/id**, never the localized name; merchant rules and code key on the id.
- **Classification is unaffected** (slug-based; display-only localization).
- **English is canonical/default**; pt/es live in the translations map; cold-start locale `en`.
- **User categories/sub-categories/tags stay literal** (out of scope: localizing them, tool/error strings,
  currencies; region merchant packs are a future extension — do NOT add BR/ES packs here).
- **No destructive DB ops in code** — no drop/reset/rename-FK migration; the reset is the manual script only.
- **AI-locale guardrails are part of the contract** (via `locale_source` + the `set_locale` description).
- **Diplomatic layering**: translations pure in `logic/`; `settings` repo in `diplomat/db`; resolution at the
  adapter/controller boundary; constants over literals (locale zod enum `.enum.*`).
- **Docs in the same change**: `docs/mcp-tools.md` (`set_locale`/`get_preferences`; `list_categories` is
  locale-resolved), `docs/architecture.md` (English seed, `settings`, `i18n_key`, identity-vs-name invariant),
  `CLAUDE.md` data conventions. Leave this design doc as-is.

### Finish
Conventional Commits (`feat(categories): English-canonical seed + i18n + AI-driven locale` + `test:`/`docs:`),
`git push -u origin feat/category-i18n`, open a PR targeting `main`. Do not merge; after CI, reply to review
threads with the resolving SHA.
