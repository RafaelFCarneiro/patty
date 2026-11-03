# ADR-008: Seed data lives in `diplomat/db/seed`; the domain never depends on it

**Status:** Accepted · **Date:** 2026-06-19 · Builds on the diplomatic architecture and the local-first
design (`docs/architecture.md`, ADR-004).

## Context

FinTrack ships **convenience seed data** so a fresh install is useful immediately: two currencies, ~15 default
categories, and a set of default merchant-classification rules. This data is pure quality-of-life — it gives
the user a ready-made starting point they can keep, edit, or ignore.

During the i18n work the seed drifted across three layers with no principled home: currency and category rows
sat inline in `diplomat/db/bootstrap.ts`, the category translation map lived in `logic/i18n.ts`, and the
merchant rules plus `DefaultCategoryId`/`MerchantRule` types were placed in `models/`. That raised a recurring
question — *"where does canonical/reference data live?"* — and an earlier proposal to answer it with a single
globally-importable `src/data/` (or `src/resources/`) layer.

The proposal is rejected on a first principle:

1. **Seed is quality-of-life, not a requirement.** Its only job is to write convenience rows into the DB on
   boot. Its existence is a plus, never a precondition.
2. **The domain must run on an empty database.** Every feature must work with zero seeded rows. Therefore the
   domain (`models/`, `logic/`, `controllers/`) must not *depend* on any seed value.

A layer that *everyone* can import (`data/`, `resources/`, or `models/`) defeats principle #2: it invites the
domain to couple to seed contents. The dependency rule has to make that coupling structurally impossible, not
merely discouraged.

## Decision

1. **Seed is a persistence-initialization concern and lives under the db diplomat:** `diplomat/db/seed/`
   (`currencies.ts`, `categories.ts`, `merchant-rules.ts`), consumed **only** by `diplomat/db/bootstrap.ts`.
2. **The domain never imports seed.** Because `models/`, `logic/`, and `controllers/` do not import `diplomat/`,
   the independence is **structural**, not a convention to remember.
3. **Seed-only types move into `seed/`.** `DefaultCategoryId` (the canonical seed slugs) and the seed-authoring
   `MerchantRule` shape are seed concerns, not domain models — they relocate from `models/` into
   `diplomat/db/seed/`. `models/Category` keeps a generic `Id`; the domain never names a seed slug.
4. **Dependency direction:** add `diplomat/db/seed/ → models/` (types only) to the table, and the rule
   *nothing outside `diplomat/db` imports `seed/`.*
5. **"Boots on an empty DB" is an invariant.** The app starts and every tool/route works with no seed applied;
   an integration test exercises a feature against an unseeded DB to lock it in.

## Options Considered

### Option A — Seed inline in `bootstrap.ts` (status quo before this ADR)
| Dimension | Assessment |
|---|---|
| Complexity | Low now, grows unwieldy |
| Domain independence | Accidental (data isn't imported by domain, but nothing enforces it) |
| Scalability | Poor — large data tables bloat the persistence glue |

**Pros:** simplest; no new files.
**Cons:** reference data is trapped in the persistence-mechanics file; no shared home as it grows (more
locales, bigger merchant packs); mixes "what to seed" with "how to seed".

### Option B — A globally-importable `data/` (or `resources/`) layer
**Pros:** one obvious home; trivial to import from anywhere.
**Cons:** *importable from anywhere* is exactly the problem — it invites `controllers/`/`logic/` to depend on
seed values, violating "the domain runs on an empty DB". Adds a new top-level layer for data the domain must
not see.

### Option C — Canonical data in `models/`
**Pros:** "single source of truth" framing; everyone already imports `models/`.
**Cons:** the domain *can* import it, so the coupling risk remains; bloats the schema layer with data tables,
blurring "models = zod schemas". (This is the placement this ADR explicitly reverses.)

### Option D — `diplomat/db/seed/`, domain-isolated — **chosen**
**Pros:** seed lives with the layer that owns the database and is the only thing that consumes it; the domain
*cannot* import it; `bootstrap.ts` becomes pure "migrate + seed" mechanics; seed grows freely without touching
the domain.
**Cons:** seed is slightly less convenient to import (only the db layer may) — which is the whole point.

## Trade-off Analysis

The tension is **import convenience vs. enforced independence**. Options B and C optimize convenience and pay
for it with a standing coupling hazard. Option D deliberately constrains who may import seed so that principle
#2 is guaranteed by the module graph rather than by reviewer vigilance. For data whose defining property is
"the system must work without it," enforced independence is worth more than ergonomic imports.

## Consequences

- **`bootstrap.ts` becomes pure mechanics:** apply migrations, then call seed modules. The *content* moves to
  `diplomat/db/seed/`.
- **`models/` returns to schema-only:** `DefaultCategoryId` and `MerchantRule` leave `models/` (reversing the
  placement introduced just prior). The merchant-rule data and category/currency seed all land in `seed/`.
- **New invariant + test:** "every feature works on an empty DB"; a focused integration test runs an unseeded
  DB through a representative tool.
- **Future seed is free:** more locales, larger merchant packs, or new default taxonomies are added under
  `seed/` only — no domain change, no new top-level layer.
- **Docs:** `docs/architecture.md` gains the `seed/` location, the dependency-table row, and the empty-DB
  invariant; `docs/canonical/code-quality.md`/`code-style.md` reference seed isolation when discussing where data lives.
- **Related:** ADR-009 (localized content on the entity) relies on this — seeded translations become seed data
  in `diplomat/db/seed/categories.ts`, not a domain-level catalog.

## Action Items

1. [ ] Create `src/diplomat/db/seed/{currencies,categories,merchantRules}.ts`; move `CURRENCIES`, `CATEGORIES`,
   `DEFAULT_MERCHANT_RULES` there.
2. [ ] Move `DefaultCategoryId` and `MerchantRule` out of `models/` into `diplomat/db/seed/`.
3. [ ] Reduce `bootstrap.ts` to migrate + invoke seed modules.
4. [ ] Add the dependency-table row and the empty-DB invariant to `docs/architecture.md`.
5. [ ] Add an integration test asserting a representative feature works against an unseeded DB.
