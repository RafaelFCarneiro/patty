# Feature Design 006: Localized account-type labels (chrome i18n catalog)

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Not started · **Branch:** `feat/account-type-labels` (suggested) ·
**Date:** 2026-06-21 · Realizes the **chrome exception** reserved by **ADR-009** (i18n catalogs are for chrome).

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

`set_locale` localizes default **category** names (ADR-009), but **account types** still display only in English
(`checking | savings | wallet | investment | credit`). A pt/es user sees "checking" where they expect "conta
corrente" / "cuenta corriente". We want the active locale to localize the account-type label too.

This is the mirror image of the category case, and ADR-009 already drew the line:

- **Category names** are *dynamic content* with a lifecycle (created, renamed, user-made) → localized **on the
  entity** (the `names` JSON column). A catalog was the *wrong* tool there.
- **Account types** are a *fixed, closed, code-defined enum* — **chrome**, not content. ADR-009 explicitly
  reserved the **translation-catalog** pattern for exactly this. So the catalog returns here, correctly, for the
  case it was meant for. (This is not a contradiction of deleting `logic/i18n` for categories — it's the other
  half of ADR-009 finally being used.)

The enum **value** is the stable identity (stored, filtered on, keyed in code). Only the **display label** is
localized — same identity-vs-display split as categories (`id` vs `displayName`).

## Decision

1. **A chrome label catalog in `logic/`.** A pure, code-owned map `AccountType → { en, pt, es }` plus a pure
   `localizeAccountType(type, locale)` (English fallback). Lives in `logic/` (e.g. `src/logic/labels.ts`) — pure
   data + a pure function, unit-testable, no I/O. Header comment scopes it: **chrome/fixed-enum labels only —
   never dynamic content** (category names live on the entity; ADR-009).
2. **Identity unchanged; add a display label.** Account `type` stays the enum value everywhere (DB, filters,
   `create_account`/`list_accounts` `type` arg). Account read views (`list_accounts`, `get_account_balances`)
   gain a localized **`typeLabel`** field resolved at read time. Nothing that keys on `type` changes.
3. **Resolved at read time via the active locale.** The account controller reads the effective locale (settings
   deps, same resolution as categories: `FINTRACK_LOCALE ?? settings.locale ?? 'en'`) and maps each account to
   include `typeLabel = localizeAccountType(type, locale)`. Switching locale reflows labels with no migration —
   exactly like category names.
4. **No schema change, no migration.** Labels are code, not data — there is nothing to store. Adding/adjusting a
   translation is a one-line edit to the catalog.
5. **Generalizable.** The same catalog hosts other fixed-enum labels when wanted — `CategoryKind`
   (`expense|income|both`), `RecurringPeriod` (`weekly|monthly|yearly`), `BillStatus` (`open|closed|paid`),
   transaction `type`/`status`. v1 ships **account types**; the rest are one map-entry + one resolver each
   (noted follow-up).

### Label catalog (starting set — implementer may refine)

| type | en | pt | es |
|---|---|---|---|
| `checking` | Checking | Conta corrente | Cuenta corriente |
| `savings` | Savings | Poupança | Ahorros |
| `wallet` | Wallet | Carteira | Billetera |
| `investment` | Investment | Investimentos | Inversiones |
| `credit` | Credit card | Cartão de crédito | Tarjeta de crédito |

## Scope / out of scope

- **In:** the chrome label catalog + `localizeAccountType` in `logic/`; a localized `typeLabel` on the
  `list_accounts` / `get_account_balances` account views, resolved via the active locale; unit + integration
  tests; `docs/mcp-tools.md` note. No schema change.
- **Out:** localizing **other fixed enums** (category kind, recurring period, bill status, transaction
  type/status) — same pattern, deferred follow-up; localizing **currency names** (those are seed *data*, a
  different case); localizing tool descriptions / error messages (still out, per Design 002); changing the
  `type` enum values or accepting localized type input (input stays the enum value).

## Options Considered

### Chrome i18n catalog (ADR-009's reserved pattern) — **chosen**
**Pros:** correct tool for a fixed, closed enum; zero schema/data (labels are code); one uniform resolver;
trivially extensible to other enums; identity (the enum) untouched.
**Cons:** adding a locale/label is a code change (right for developer-owned chrome).

### Names-on-the-entity (like categories, ADR-009) — rejected here
**Cons:** there is no per-row "account type" entity to hang names on — types are a shared closed enum, not
user-created rows. Storing per-row type labels would duplicate a fixed set across every account. Wrong tool for
chrome (the inverse of why it was right for categories).

### Let the agent translate in chat — rejected
**Cons:** inconsistent (depends on the model), not reflected in the structured tool output, and `set_locale`
wouldn't deterministically drive it. Server-side resolution matches how category names already work.

## Consequences

- **New:** `src/logic/labels.ts` (the catalog + `localizeAccountType`, pure + unit-tested); the account
  controller resolves `typeLabel` via the active locale; the account read view/wire gains `typeLabel`.
- **Reuse:** the effective-locale resolution already used for category names (settings deps).
- **`logic/i18n`-style catalog returns — but chrome-only.** The `labels.ts` header states it is for fixed enums
  only, so the ADR-009 anti-pattern (catalog for dynamic content) can't creep back.
- **Docs:** `docs/mcp-tools.md` notes `list_accounts` / `get_account_balances` include a locale-resolved
  `typeLabel`.
- **Blast radius:** additive — one logic module + the account controller/view + docs. No schema, no change to
  `type` semantics, filters, or other tools.

---

## Implementation prompt

> Hand this to a coding agent. The design above is the source of truth; **read ADR-009** (the chrome exception)
> first. Work on branch **`feat/account-type-labels`** off `main`; `git fetch && git rebase origin/main` first.
> Read `CLAUDE.md` (esp. the **Definition of Done**), `docs/architecture.md`, `docs/code-style.md`,
> `docs/code-quality.md`. Look at how category names are localized at read time (the settings/locale resolution
> and the category adapter/controller) and mirror it; skim `src/models/account.ts`, `src/controllers/accounts.ts`,
> `src/adapters/accounts.ts`, `src/wire/out`, and `src/diplomat/mcp/server.ts` (`list_accounts`,
> `get_account_balances`).

### Steps

1. **Catalog** (`src/logic/labels.ts`): `const ACCOUNT_TYPE_LABELS: Record<AccountType, Record<Locale, string>>`
   (use the table above) and `export const localizeAccountType = (type, locale) => ACCOUNT_TYPE_LABELS[type][locale]
   ?? ACCOUNT_TYPE_LABELS[type].en`. Pure, no I/O. File header: *chrome/fixed-enum labels only — dynamic content
   (category names) lives on the entity (ADR-009).* Use the `Locale` and `AccountType` enums; no bare literals.
2. **Read view** gains `typeLabel`: extend the account output shape (`wire/out` + the `AccountBalance`/list view)
   with `typeLabel: string`. Keep `type` (the enum) as-is.
3. **Controller** (`controllers/accounts.ts`): in `listAccounts` and `getAccountBalances`, read the effective
   locale (settings deps, same as categories) and map each account to include
   `typeLabel: localizeAccountType(account.type, locale)`. Keep the rest of the pipeline intact.
4. **No schema/migration.** Nothing stored.
5. **Docs:** note the localized `typeLabel` on `list_accounts` / `get_account_balances` in `docs/mcp-tools.md`.

### Tests
- **Unit** (`logic/labels.test.ts`): `localizeAccountType` returns the pt/es/en label per locale; falls back to
  `en` for a missing locale; covers every `AccountType` member (so adding a type without a label is caught).
- **Integration** (in-process libSQL): create accounts of a couple types; with locale `en`, `list_accounts` /
  `get_account_balances` return English `typeLabel`; after `set_locale('pt')`, the same calls return Portuguese
  `typeLabel`, while `type` (the enum value) is unchanged.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **Identity is the enum** (`type`); `typeLabel` is derived display only — nothing keys on the label.
- **Chrome catalog is for fixed enums only** (ADR-009) — never use it for dynamic content; the `labels.ts`
  header states this.
- **Read-time resolution** via the active locale (no stored labels, no migration); locale switch reflows.
- **Diplomatic layering:** pure catalog + resolver in `logic/`; the controller supplies the locale and maps;
  thin diplomats; constants over literals (`AccountType.enum.*`, `Locale` enum).
- **Docs in the same change:** `docs/mcp-tools.md` (`typeLabel` on the two account read tools).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push. Small, single-area change — the
  inline self-review suffices.

### Finish
Conventional Commits (`feat(accounts): localized account-type labels` + `test:`/`docs:`),
`git push -u origin feat/account-type-labels`, open a PR targeting `main`. Run the Definition of Done; do not
merge; after CI, reply to review threads with the resolving SHA.

## Deferred follow-up

- **Other fixed-enum labels** via the same catalog: `CategoryKind`, `RecurringPeriod`, `BillStatus`, transaction
  `type`/`status`. Each is one map entry + one resolver — add when a surface needs them localized.
