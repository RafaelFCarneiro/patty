# Feature Design 022: Demo instance — a seeded, throwaway FinTrack to try before installing

**Type:** Feature design · **Design status:** Accepted · **Implementation status:** Done ·
**Date:** 2026-10-23 · Builds on the multi-user/tenancy work (ADR-033) without using it: the demo is a
**separate database**, never a user inside a real one. Reuses the write flows as they are (no demo-only write
path) and the MCP prompts of Feature Design 019.

## Context

Someone evaluating FinTrack today installs it and meets empty dashboards: nothing to chart until they have fed
in months of transactions. The product's value — dashboards over real history, and an AI that can answer, tag,
import and build views over it — is invisible on day one.

A demo should let a person see that value in minutes, in their language, without touching (or creating) their
real finances, and should make it unmistakable — to the person *and* to the AI client — that they are looking at
demo data.

## Decision

**A separate demo database, seeded by the product's own write flows, marked as a demo inside the database, run
on its own port, and paired with a guided `tour` MCP prompt.**

### 1. One command, one throwaway database

```bash
npx @rafaelfcarneiro/fintrack@latest demo [--country br|us|mx|co] [--reset]
```

- Creates (or reuses) `~/.fintrack/demo.db` (`DEMO_DB_PATH`), never the real `DB_PATH`. Seeds it on first run
  and prints where the dashboards are. `--reset` deletes and re-seeds it — after proving the file it is about to
  delete is a demo database (§3); it refuses to delete anything else. After seeding, `demo` serves the dashboards,
  REST and MCP on the demo port until interrupted (no login, §2) and says so; run again it reuses a seeded demo.
- A seed that stops partway never leaves a half-seeded demo that reads as finished: the seeder records completion as
  its last step (`settings.demo_seeded_at`, written through a flow like the marker, together with `settings.demo_country`, the data set it seeded, which the `tour` prompt reads). `demo` deletes a database it just
  created when its first seed fails; a demo found later without that marker is reported as interrupted, with the
  `--reset` command, instead of "already seeded".
- `--country` picks the demo's data set, and with it the language and currency (§4): `br` (pt, BRL), `us`
  (en, USD), `mx` (es, MXN), `co` (es, COP). A language alone can't choose, since Spanish has two data sets.
  Default: the OS locale's region when it is one of the four (`es-CO` → `co`); otherwise its language
  (`pt` → `br`, `es` → `mx`, `en` → `us`); otherwise `us`.
- Runs on its own sidecar port, `DEMO_PORT = 51738` (the real install keeps `51737`), so both can run at once.
- `npx @rafaelfcarneiro/fintrack@latest setup <client> --demo` adds a **second** MCP entry, `fintrack-demo`,
  pointing at the demo database (`DB_PATH`, `PORT`, `FINTRACK_DEMO=1` in its `env`); it never replaces the
  `fintrack` entry. `setup <client> --remove-demo` removes it.
- Docker is out of scope for v1 (it depends on the public image and `init`, a separate decision).

### 2. No login, no keychain — on purpose, and only for the demo

- **Auth disabled.** The demo runs with `FINTRACK_AUTH=disabled` (loopback only — the existing guard already
  refuses disabled auth on an exposed host). No setup, no sign-in approval: the demo is about the finance
  features, and friction there defeats it. The real install is unchanged: auth stays `required` by default.
- **A fixed, published demo key** (`DEMO_DB_KEY`, a constant). The data is fake and public, so the encryption
  protects nothing — and saying so honestly is better than a keychain entry that implies otherwise. It also means
  the demo never prompts for keychain access and a real database never opens with the demo key. The banner
  (§5) tells the person not to enter real data there.

### 3. The database knows it is a demo

- Migration adds `settings.instance_kind` (`standard | demo`, default `standard`). The seeder sets `demo`.
- **The marker, not the file name or an env var, is the source of truth.** Everything that shows "demo" reads
  it from the database: the UI banner, the MCP server instructions, `get_status` (`demo: true`). An env var or a
  path can be wrong; the database can't be "accidentally" demo.
- `--reset` opens the file with the demo key and checks `instance_kind = demo` before deleting it. A path that is the
  real `DB_PATH` (also through a symlink), a file that does not open with the demo key, and a database marked
  `standard` are all refused and left byte for byte as they were.
- The demo never runs against a `standard` database: `fintrack demo` refuses a `DEMO_DB_PATH` whose database
  is not marked demo and holds data. (An empty database that opens with the demo key and was never marked — a run
  that died between creating the file and marking it — has nothing to lose and is seeded.)
- Known limit: `--reset` does not check whether another process (a running `fintrack-demo` server or another `demo`) has the
  file open; stop it first.
- A process started with `FINTRACK_DEMO=1` (the demo key, auth off) refuses to serve a database that is not marked
  demo, so the public key and the open door never apply to anything else.

### 4. The seed: four months, four countries, three languages, generated through the real flows

- **Generated, not stored.** A deterministic generator (seeded PRNG + country) produces the dataset relative to
  **today**: the last four full months plus the current one, so the dashboards always look current.
- **Through the write flows** — `createAccount`, `createCreditCard`, `addAccountExpense`/`Income`,
  `addCardPurchase`, `createTransfer`, `payBill`, `createRecurring`, `applyDueRecurring`, `createBudget`,
  `createTag`, `setExchangeRates` — run via `runEffects` with a clock set to each item's date. So bills,
  idempotency keys, classification and merchant learning behave exactly as in real use, and the seeder is also
  a broad end-to-end exercise of the write path. No raw SQL.
- **Coverage:** checking, savings, investment and wallet accounts; two credit cards with paid, closed and open
  bills; monthly salary; rent and subscriptions as recurring rules; groceries, transport, restaurants, health,
  leisure with merchant variety; transfers between accounts; pending future items; budgets (some over, some
  under); a small USDC/BTC position with exchange rates so converted totals show; and **one trip** (§6).
- **Four countries, four data sets.** The country pack sets the demo user's `user_settings.locale` (UI and
  category names already resolve per locale) and supplies account and card names, merchants, descriptions,
  the trip's destination, and amounts shaped to the currency.
  - `br` → pt, BRL (e.g. Nubank, Itaú; iFood, Uber, Pão de Açúcar; rent "Aluguel"; a trip to Florianópolis).
  - `us` → en, USD (e.g. Nubank, Chase, Amex; Whole Foods, Lyft, Netflix; a trip to Denver).
  - `mx` → es, MXN (e.g. Nu México, BBVA México, Banorte; Oxxo, Soriana, Rappi, DiDi; rent "Renta"; a trip to
    Oaxaca).
  - `co` → es, COP (e.g. Nu Colombia, Bancolombia, Davivienda; Éxito, Carulla, Rappi, DiDi; rent "Arriendo"; a
    trip to Cartagena).
  Nubank appears in all four packs: it operates in Brazil, Mexico and Colombia, and in the US since
  September 2026 (savings account and credit card). The `us` pack lists it next to Chase and Amex.
  The `br` pack also has a USD **Conta Global** (Nubank's dollar account for Brazilians): a second-currency
  account with a few dollar purchases, so the converted totals (BRL ↔ USD) show on real-looking data.
  MXN and COP are new currencies (§4.2). Country packs live in `diplomat/db/seed/demo/<country>.ts`; the
  generator's rules (cadence, amounts, distribution) are pure, in `logic/demo/plan.ts`, and shared by all four.
  Amounts are expressed per pack in local terms (a COP rent is in the millions, an MXN one in the thousands), so
  the dashboards look plausible in each country.

#### 4.2 MXN and COP join the currencies (for every install, not only the demo)

- `CurrencyCode` (`models/money.ts`) gains `MXN` and `COP`, and the currency seed gains
  `{ code: MXN, symbol: 'MX$', name: 'Peso Mexicano', decimals: 2 }` and
  `{ code: COP, symbol: 'COL$', name: 'Peso Colombiano', decimals: 2 }`. Prefixed symbols, not a bare `$`, so
  neither reads as USD next to it.
- COP uses 2 decimals, its ISO 4217 minor unit, even though centavos are rarely used in practice. Amounts stay
  exact either way; whether the UI hides `,00` for COP is a display choice, out of scope here.
- Purely additive, like the crypto currencies under ADR-026: fiat, the fiat staleness threshold; no conversion
  is implied. Existing databases get the rows from the bootstrap seed (`seedCurrencies` is insert-if-missing —
  confirm, and add a migration only if it is not).
- Any exhaustive `Record<CurrencyCode, …>` map in `src/` or `ui/` (symbols, formatting, crypto/fiat class) gets
  its MXN and COP entries; the type checker finds the `src/` ones, a grep finds the `ui/` ones.

### 5. Making "this is the demo" unmistakable

- **UI:** a persistent banner on every page (shell and auth pages alike) — "Demo — sample data, not your
  finances. [Install FinTrack for your own data]" — in a distinct accent; every page `<title>` starts with
  `[Demo]`. Driven by the marker (§3), so it cannot be missing on a demo database. The banner (and the MCP
  `instructions` below) is written in the demo's language — `en`, `pt` or `es`, from the owner's
  `user_settings.locale`, which the seeder sets from the country pack. The banner link still points at the
  repository README until the distribution decision (public package) is made.
- **Terminal:** `fintrack demo` prints that it is a demo, the dashboard URL, and how to install for real.
- **MCP:** the server sends `instructions` at initialize when the database is a demo: it is a demo with sample
  data; say so once when you start working with it; never use it for the person's real finances; for those, use
  the `fintrack` server. `get_status` reports `demo: true`.

### 6. The `tour` MCP prompt (and a skill)

An MCP prompt `tour` (no arguments: it reads the demo's country and language from the database), alongside `monthly_review`/`budget_checkup`/`import_statement` (Feature
Design 019 chose MCP prompts over Claude skills for portability — Claude, Copilot and others all list
prompts). A thin `skills/patty-tour/SKILL.md` points Claude users at the same steps. The steps, in the
demo's language:

1. "What are my balances?" — accounts, cards, the converted total.
2. "Where did my money go last month?" — spending by category.
3. "Am I over budget?" — budget status, pending-aware.
4. "Import this statement" — the prompt includes a short sample statement for the demo's country; shows classification
   and `needs_review`.
5. **"Tag everything from my trip to <destination> as travel, then build me a travel dashboard."** The trip is
   seeded *untagged* across several categories (flights, hotel, restaurants, local transport, tours, gifts) and
   funding sources over ~6 days, so the AI has to find it by dates and descriptions, tag it, and build a
   dashboard — the clearest demonstration of what an AI-first app adds.
6. "Ready for your own data?" — how to install FinTrack for real, and how to remove the demo entry
   (`setup <client> --remove-demo`).

### 7. Both installations in one AI client

- They are **two MCP servers with distinct names** (`fintrack`, `fintrack-demo`). Clients namespace tools by
  server, so the AI sees two sets of the same tools.
- The risk is the AI writing a real expense into the demo (or reading demo numbers as real). Mitigations, in
  order: the demo server's `instructions` (§5); the demo entry is **opt-in** (`--demo`), never written by plain
  `setup`; the tour's last step offers to remove it; and the demo's writes are harmless (`--reset` restores it).
- The two never share state: different database, port, key and (with auth disabled) no keychain sign-in.

## Options considered

- **A demo user inside a real instance** — rejected: it needs a second way to create users (breaking "only an
  invite creates a user"), puts fake data in real backups and instance-wide counts.
- **A shipped database file** — rejected: dates go stale, it must be regenerated per release and per country, and
  it bypasses the write flows (data could drift from what the flows would produce).
- **Auth required with a printed demo login** — rejected for v1: adds setup and sign-in steps to a five-minute
  evaluation. Revisit if a hosted public demo is ever offered (that one must have auth).
- **Keychain-held demo key** — rejected: implies protection the public data doesn't need, and prompts for
  keychain access.

## Decided

1. **Spanish demos = Mexico (MXN) and Colombia (COP)** (decided 2026-10-23). A Spain/EUR demo and a
   USD-with-Latin-flavour demo were considered; Latin America is the audience in mind, and both currencies are
   added as real currencies (§4.2) rather than faked in USD. Because two packs share Spanish, the demo is chosen
   by `--country`, not `--locale`.

## Testing

- **Generator (unit, pure):** deterministic for a seed + country + today; covers every entity kind listed in §4;
  dates fall within the last four months + current; the trip is untagged, spans ≥4 categories and ≥2 funding
  sources; each country pack has every key the generator asks for and uses its own currency and locale (one test across
  the four); the `--country` default from the OS locale (`es-CO` → `co`, `es` → `mx`, `pt` → `br`, other → `us`).
- **Seeder (integration):** seeding a fresh database yields the expected counts per entity; bills end up in the
  expected statuses; budgets include over and under; re-running `demo` without `--reset` doesn't duplicate
  (idempotency keys hold); `instance_kind = demo`.
- **Safety:** `--reset` refuses a database not marked demo, and a path equal to the real `DB_PATH`; `demo`
  refuses a non-demo database at `DEMO_DB_PATH`.
- **Visibility:** the banner renders on every page of a demo database and never on a standard one; MCP
  `instructions` present only for a demo; `get_status.demo`.
- **Setup:** `--demo` adds `fintrack-demo` without touching `fintrack`; `--remove-demo` removes only it.
- **Tour prompt:** registers, uses the demo's language and the trip destination, includes the sample statement.

## Docs to update

- `README.md` — a "Try the demo" section at the top (one command), before the install steps.
- `docs/demo.md` (new, short) — what the demo contains, the tour, the two-servers note, reset/remove.
- `docs/mcp-tools.md` — the `tour` prompt; `get_status.demo`.
- `docs/architecture.md` — `settings.instance_kind`, the demo path/port/key constants, "the database marks the
  demo".
- `CLAUDE.md` (+ `.github/copilot-instructions.md`) — the demo command and its guarantees in Development setup.

## Implementation prompt

Implement this design in phases, one branch each, behind the full gate.

0. **`feat/currencies-mxn-cop`** — §4.2: `MXN` and `COP` in `CurrencyCode` and the currency seed, every
   exhaustive currency map updated, existing databases get the rows. Tests: the seed includes both with
   2 decimals; an MXN and a COP account and expense round-trip; `GET /api/currencies` and `fintrack://currencies`
   list them. Small and independent — it can
   merge before the rest.
1. **`feat/demo-marker`** — migration `settings.instance_kind`; `get_status.demo`; the UI banner and `[Demo]`
   titles; MCP `instructions` for a demo database. Tests for each. No seeder yet (mark a test database by hand).
2. **`feat/demo-seed`** — `logic/demo/plan.ts` (pure generator) + the four country packs in `diplomat/db/seed/demo/` + the
   seeder that runs the generated plan through the write flows with a per-item clock. Tests per §Testing.
3. **`feat/demo-command`** — `fintrack demo [--country] [--reset]`, `DEMO_DB_PATH`, `DEMO_PORT`, `DEMO_DB_KEY`,
   auth disabled; `setup <client> --demo` / `--remove-demo`. Safety tests.
4. **`feat/demo-tour`** — the `tour` MCP prompt with the six steps and a sample statement per country;
   `skills/patty-tour/SKILL.md`; README "Try the demo"; `docs/demo.md`.

Constraints throughout: no demo-only write path (the seeder calls the real flows); no change to real-install
defaults (auth required, keychain key, port 51737); the demo never reads or writes the real `DB_PATH`.

### Finish (every push)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing. Phases 1 and 2 touch a
migration / span layers, so each also gets the independent verification subagent.
