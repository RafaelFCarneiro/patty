# Feature Design 006: Localized fixed-enum labels (chrome i18n catalog)

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Not started · **Branch:** `feat/account-type-labels` ·
**Date:** 2026-06-21 · Realizes the **chrome exception** reserved by **ADR-009** (i18n catalogs are for chrome).

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

`set_locale` localizes default **category** names (ADR-009), but the system's **fixed enum values** still
display only in English: account types, category kinds, recurring periods, bill statuses, and transaction
type/status. A pt/es user sees "checking", "expense", "monthly", "open", "pending" untranslated.

This is the mirror image of the category case, and ADR-009 already drew the line:

- **Category names** are *dynamic content* with a lifecycle → localized **on the entity** (the `names` column).
  A catalog was the *wrong* tool there.
- **These enums** are *fixed, closed, code-defined* sets — **chrome**, not content. ADR-009 explicitly reserved
  the **translation-catalog** pattern for exactly this. So the catalog returns here, correctly, for the case it
  was meant for (not a contradiction of deleting `logic/i18n` for categories — the other half of ADR-009).

In every case the enum **value** is the stable identity (stored, filtered on, keyed in code). Only the
**display label** is localized — the same identity-vs-display split as categories (`id` vs `displayName`).

## Scope — the six user-facing fixed enums

| Enum | Values | Surfaces (read views) | Added label field |
|---|---|---|---|
| `AccountType` | checking, savings, wallet, investment, credit | `list_accounts`, `get_account_balances` | `typeLabel` |
| `CategoryKind` | expense, income, both | `list_categories`, `list_sub_categories` | `kindLabel` |
| `RecurringPeriod` | weekly, monthly, yearly | `list_recurring` | `periodLabel` |
| `BillStatus` | open, closed, paid | `get_bill` (`bill.*`) | `statusLabel` |
| `TransactionType` | expense, income, transfer | `TransactionView` (search/create/update/bill rows) | `typeLabel` |
| `TransactionStatus` | pending, effective | `TransactionView` | `statusLabel` |

**Excluded (deliberately):** `MovementType` (input-only subset of `TransactionType`), `ClassificationMethod`,
`TransactionSource`, `LocaleSource` — internal/audit, not user-facing display.

## Decision

1. **One chrome label catalog in `logic/`** (`src/logic/labels.ts`): a per-enum typed map
   `Record<Enum, Record<Locale, string>>` and a per-enum resolver `localize<Enum>(value, locale)` with English
   fallback. Pure data + pure functions, unit-tested, no I/O. File header scopes it: **chrome / fixed-enum
   labels only — never dynamic content** (category names live on the entity; ADR-009). Per-enum typed maps
   (not a generic dispatcher) so the type system enforces exhaustiveness — a new enum member without a label is
   a compile error.
2. **Identity unchanged; add a derived display label.** Each enum value stays as-is everywhere (DB, filters,
   tool inputs). The relevant **read views** gain the localized `*Label` field from the table above. Nothing
   that keys on the enum changes.
3. **Resolved at read time via the active locale** (`FINTRACK_LOCALE ?? settings.locale ?? 'en'`, same as
   category names). The controller (or the view-assembly boundary) reads the effective locale and fills the
   `*Label`. Switching locale reflows all labels with no migration.
4. **No schema change, no migration.** Labels are code, not data — nothing stored. Adding/adjusting a
   translation is a one-line catalog edit; adding a locale is data-only across the maps.
5. **`TransactionView` labels resolve in one place.** `TransactionType`/`TransactionStatus` labels appear on
   every transaction row, returned by many tools — resolve them at the single view-assembly point (the
   transaction `dbToModel`/view path given the active locale, or one controller-side mapper) rather than
   scattering per call site.

### Label catalog (starting set — implementer may refine)

```
AccountType      en / pt / es
  checking       Checking / Conta corrente / Cuenta corriente
  savings        Savings / Poupança / Ahorros
  wallet         Wallet / Carteira / Billetera
  investment     Investment / Investimentos / Inversiones
  credit         Credit card / Cartão de crédito / Tarjeta de crédito
CategoryKind
  expense        Expense / Despesa / Gasto
  income         Income / Receita / Ingreso
  both           Both / Ambos / Ambos
RecurringPeriod
  weekly         Weekly / Semanal / Semanal
  monthly        Monthly / Mensal / Mensual
  yearly         Yearly / Anual / Anual
BillStatus
  open           Open / Aberta / Abierta
  closed         Closed / Fechada / Cerrada
  paid           Paid / Paga / Pagada
TransactionType
  expense        Expense / Despesa / Gasto
  income         Income / Receita / Ingreso
  transfer       Transfer / Transferência / Transferencia
TransactionStatus
  pending        Pending / Pendente / Pendiente
  effective      Effective / Efetivada / Efectiva
```

## Out of scope / notes

- Internal/audit enums (above) — not localized.
- **Currency names** — those are seed *data* (the `currencies.name` column), a different case, not this catalog.
- Tool descriptions / error messages — still out (Design 002).
- **Pre-existing drift to flag (do NOT fix here):** `RecurringPeriod` model = `['weekly','monthly','yearly']`
  but the `recurring_rules.period` schema enum = `['monthly','weekly']` (missing `yearly`). It's a type-level
  hint (SQLite doesn't enforce it), but the two should agree. File a separate tech-debt issue; this i18n change
  doesn't touch it.

## Options Considered

The model choice (catalog vs. names-on-entity vs. agent-translates) is settled by **ADR-009** — catalog is the
reserved pattern for chrome. Not re-argued here.

### Chrome i18n catalog — **chosen**
**Pros:** correct tool for fixed, closed enums; zero schema/data (labels are code); one uniform per-enum
resolver; identity untouched; trivially extensible (new locale = data, new enum = one map + resolver).
**Cons:** adding a label/locale is a code change — right for developer-owned chrome.

### Names-on-the-entity (like categories) — rejected
**Cons:** there are no per-row entities for these enums — they're shared closed sets; storing per-row labels
would duplicate a fixed set everywhere. Wrong tool for chrome (the inverse of why it was right for categories).

### Let the agent translate in chat — rejected
**Cons:** inconsistent, not in the structured output, and `set_locale` wouldn't deterministically drive it.
Server-side resolution matches how category names already work.

## Consequences

- **New:** `src/logic/labels.ts` (per-enum maps + resolvers, pure + unit-tested); `*Label` fields on the read
  views in the scope table; controllers/adapters resolve them via the active locale.
- **Reuse:** the effective-locale resolution already used for category names (settings deps).
- **`logic/i18n`-style catalog returns — but chrome-only**, guarded by the file header so the ADR-009
  anti-pattern can't creep back.
- **Docs:** `docs/mcp-tools.md` notes the `*Label` fields on the affected read tools.
- **Blast radius:** additive — one logic module + label fields across several read views. No schema, no change
  to enum semantics, filters, inputs, or classification. Broader than a single tool (accounts, categories,
  recurring, bills, transactions), so treat as **feature-sized** for the DoD.

---

## Implementation prompt

> Hand this to a coding agent. Source of truth: this design; **read ADR-009** (the chrome exception) first.
> Work on branch **`feat/account-type-labels`** (already exists with this doc); `git fetch && git rebase
> origin/main` first. Read `CLAUDE.md` (esp. the **Definition of Done**), `docs/architecture.md`,
> `docs/code-style.md`, `docs/code-quality.md`. Mirror how default **category names** are localized at read time
> (the settings/locale resolution + category controller/adapter). Skim the models for the six enums, and the
> read paths: `controllers/accounts.ts`, `controllers/categories.ts`, `controllers/recurring.ts`,
> `controllers/bills.ts`, `adapters/transactions.ts` (the `TransactionView` assembly), `wire/out`, and
> `diplomat/mcp/server.ts`.

### Steps

1. **Catalog** (`src/logic/labels.ts`): for each of the six enums, a `Record<Enum, Record<Locale, string>>`
   (use the table above) + `localize<Enum>(value, locale)` returning `map[value][locale] ?? map[value].en`.
   Pure, no I/O. File header: *chrome / fixed-enum labels only — dynamic content (category names) lives on the
   entity (ADR-009).* Use the `Locale` + enum members; no bare literals; per-enum maps for exhaustiveness.
2. **Add `*Label` to the read views** per the scope table (`wire/out` + the view types): `typeLabel`
   (accounts), `kindLabel` (categories/sub-categories), `periodLabel` (recurring), `statusLabel` (bill),
   `typeLabel` + `statusLabel` (`TransactionView`). Keep the enum value field as-is alongside the label.
3. **Resolve at read time** via the effective locale (settings deps, same as categories): in each read
   controller, map results to fill the `*Label`. For `TransactionView`, resolve at the **single** view-assembly
   point (transaction `dbToModel`/view path, threading the active locale) so it isn't scattered across the many
   transaction-returning tools.
4. **No schema/migration.** Nothing stored.
5. **Docs:** note the `*Label` fields on the affected read tools in `docs/mcp-tools.md`.
6. Do **not** fix the `RecurringPeriod` schema/model drift here — leave it; (optionally) open a tech-debt issue.

### Tests
- **Unit** (`logic/labels.test.ts`): each `localize<Enum>` returns pt/es/en per locale and falls back to `en`;
  cover **every member** of every enum (so an unlabeled member is caught).
- **Integration** (in-process libSQL): with locale `en`, the read tools return English `*Label`s; after
  `set_locale('pt')`, the same tools return Portuguese `*Label`s while the underlying enum values are unchanged.
  Cover at least one surface per enum (account `typeLabel`, category `kindLabel`, recurring `periodLabel`, bill
  `statusLabel`, transaction `typeLabel`/`statusLabel`).
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **Identity is the enum value**; `*Label` is derived display only — nothing keys on the label.
- **Chrome catalog is for fixed enums only** (ADR-009) — never for dynamic content; the `labels.ts` header
  states this.
- **Read-time resolution** via the active locale (no stored labels, no migration); locale switch reflows.
- **Diplomatic layering:** pure catalog + resolvers in `logic/`; controllers/adapters supply the locale and map;
  thin diplomats; constants over literals (enum `.enum.*`, `Locale`).
- **Docs in the same change:** `docs/mcp-tools.md` (`*Label` fields on the affected read tools).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push; this is **feature-sized**
  (touches several views), so also run the independent verification pass.

### Finish
Conventional Commits (`feat(i18n): localized labels for fixed enums` + `test:`/`docs:`),
`git push -u origin feat/account-type-labels`, open a PR targeting `main`. Run the Definition of Done; do not
merge; after CI, reply to review threads with the resolving SHA.

## Deferred follow-up

- **Adding a locale** is a data-only edit across the catalog maps + the category `names` seed.
- Internal/audit enums (`ClassificationMethod`, `TransactionSource`, `LocaleSource`) remain unlocalized unless a
  user-facing surface needs them.
