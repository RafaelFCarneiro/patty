# ADR-004: Local-first persistence — relational SQLite via libSQL (encrypted), dropping the graph DB

**Status:** Accepted · **Date:** 2026-06-15 · Supersedes the Neo4j/graph decisions in `docs/PLAN.md` and the graph model in `docs/architecture.md`. · Companions: [ADR-005](005-keychain-key-storage.md) (keychain key storage), [ADR-006](006-drizzle-orm-schema-and-migrations.md) (Drizzle ORM for schema and migrations).

## Context

The goal for the first published version of the FinTrack MCP server is a **local-only, zero-config experience**: a user runs the MCP server on their own machine (ideally via `npx`), and it just works. Neo4j blocks that goal — it is a separate server process, which in practice forces us to provide a hosted database, and a hosted multi-tenant database drags in authentication, authorization, safety guards, and multi-user data isolation. That is a different, much larger product than the local single-user tool we want to ship now.

Three questions had to be answered together.

**1. Does a graph database still earn its place?** FinTrack's access patterns were reviewed against what a graph DB uniquely provides (cheap, unbounded variable-length traversal):
- Classification (`merchant → USUALLY → category`) is a **one-hop weighted lookup**, not a traversal.
- The category hierarchy is **two levels** (category → sub-category) — a self-join, or a recursive CTE if it ever deepens.
- Bills→transactions and transactions→account/card are **bounded joins**.
- `find_correlations` (the Phase 3 differentiator) is "which categories move together / what changed" — that is **analytics** (window functions, covariance over time buckets), which SQL does as well as or better than Cypher.

Nothing on the roadmap requires deep/unbounded pathfinding. The graph model is elegant but **not load-bearing**, and it is the specific thing forcing the server dependency we want to remove.

**2. Is there an embedded graph engine we could keep instead?** No longer. **KuzuDB — the natural "SQLite for graphs" — was archived/abandoned in October 2025.** Its main migration target, FalkorDB, is a Redis module that needs a running server (defeats local-only). Newer entrants were surveyed (GraphLite, LiteGraph, and the SQLite graph extensions GraphQLite / sqlite-graph): they are either non-Node (.NET, Python/Rust only), brand-new with negligible adoption, or — for the extensions — consumed as a **per-platform native binary** that reintroduces exactly the distribution friction we want to avoid. None is a safe foundation today. The dependency-free fallback for graph *semantics* (a `nodes`/`edges` pair queried with `WITH RECURSIVE`) remains available if a real traversal feature ever appears.

**3. Which SQLite engine?** The candidates were `node:sqlite` (built into Node), `better-sqlite3` (most mature driver), and **libSQL** (Turso's SQLite fork, via the better-sqlite3-compatible synchronous `libsql` package). The deciding factors were **encryption at rest, full-text search (FTS5), and a path to hosted multi-user** — see Trade-off Analysis.

Constraints shaping the decision: ship soon; single-user, local-only for v1; **financial data, so encryption at rest is a requirement, not a nice-to-have**; multi-user/hosted is a deliberate later phase; the completed diplomat refactor means `logic/` and `controllers/` speak only domain models and repo contracts, so the persistence engine is swappable behind `diplomat/db`.

## Decision

1. **Drop the graph database. Model the domain relationally in SQLite** for v1 (single file, no server, no auth) — the local-only experience we want.
2. **Use libSQL via the synchronous `libsql` package** (better-sqlite3-compatible API). It bundles its own SQLite, so FTS5, encryption at rest, and vector search are available without depending on the host's Node build, and its embedded-replica sync is a first-class path to hosted multi-user in Phase 4 without changing engines. *(Superseded — see [Amendment 2026-06-15](#amendment--2026-06-15-driver-is-libsqlclient-async-not-the-sync-libsql-package): the runtime driver is the async `@libsql/client` via Drizzle's `drizzle-orm/libsql` adapter; the engine choice, encryption, FTS5, and hosting path are unchanged.)*
3. **Encryption at rest is ON by default.** The database file is encrypted; the key is generated and stored in the **OS keychain** (macOS Keychain / Windows DPAPI / libsecret), keeping the local experience zero-prompt while making a copied file useless on its own.
4. The graph→relational mapping is straightforward (see below); the classifier's `[:USUALLY]` edges become a `merchant_category` weight table — the learning loop is unchanged in spirit, just `UPDATE ... weight` instead of edge writes.

## Amendment — 2026-06-15: driver is `@libsql/client` (async), not the sync `libsql` package

Decision point 2 originally specified the **synchronous `libsql` package** (better-sqlite3-compatible API). During implementation (ADR-006, Drizzle ORM) the **documented, maintained** path for an encrypted local libSQL database under Drizzle turned out to be the **async `@libsql/client`** with Drizzle's `drizzle-orm/libsql` adapter:

```ts
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
const client = createClient({ url: `file:${path}`, encryptionKey }) // AES-256-CBC, no extra native libs
const db = drizzle(client)
```

We therefore **supersede the synchronous sub-choice** and use `@libsql/client` (async). Rationale: the sync `libsql`-via-`drizzle-orm/better-sqlite3` combination is undocumented for encryption and risks an accidental fall-through to real `better-sqlite3` (which has no built-in encryption), silently regressing the security posture. The async cost is immaterial — controllers already return `ResultAsync` and diplomats `await`; the "synchronous driver" in the original decision was ergonomic, not a requirement.

**Unchanged:** libSQL as the engine, the relational model, FTS5 for `search_transactions`, and encryption-at-rest ON by default with the key from the OS keychain ([ADR-005](005-keychain-key-storage.md)). The `encryptionKey` is passed to `createClient`.

**Guardrail (new requirement):** the app must fail fast if the database is opened without an encryption key, and a test must prove the file is unreadable without the correct key — this is what prevents a silent regression to an unencrypted DB if the driver is ever swapped.

**Known limitation:** `drizzle-kit` Studio/`push` cannot open an encrypted file (drizzle-team/drizzle-orm#3198). We use only `drizzle-kit generate` (offline schema diff) + runtime `migrate()` through the encrypted client, so migrations are unaffected — only Studio-based inspection of the live encrypted DB is unavailable.

## Options Considered

### Option A — Keep Neo4j (status quo)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High — separate server process |
| Local-only fit | Poor — pushes us to hosted DB + auth + multi-user |
| Maturity | High |
| Graph power | Full Cypher (not actually needed here) |

**Pros:** No code change; full graph semantics. **Cons:** Directly blocks the local-only/ship-soon goal; over-powered for our access patterns.

### Option B — Embedded graph (KuzuDB / forks / SQLite graph extensions)
| Dimension | Assessment |
|-----------|------------|
| Local-only fit | Good (embedded) |
| Maturity | **Abandoned** (Kuzu archived Oct 2025); alternatives non-Node, immature, or native-extension-only |

**Pros:** Would keep the graph model locally. **Cons:** No maintained, Node-friendly option; extensions reintroduce a per-platform native binary; unacceptable risk.

### Option C — better-sqlite3 (+ SQLCipher for encryption)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low (driver) / Medium (custom SQLCipher build) |
| Maturity | Very high — millions of weekly downloads, fastest, synchronous |
| Encryption | Only via a custom SQLCipher native build |
| FTS5 | Available (driver bundles SQLite with FTS5) |
| Hosting path | None built-in |

**Pros:** The most battle-tested, fastest Node SQLite driver. **Cons:** Turnkey encryption needs a custom native build; no first-class hosted-sync path; native module to package.

### Option D — libSQL (`libsql` sync package) — **chosen**
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low–Medium |
| Local-only fit | Excellent (local file; better-sqlite3-compatible sync API) |
| Maturity | Active, Turso-backed, but pre-1.0 |
| Encryption | **Built-in** (SQLCipher-style, on by default here) |
| FTS5 / vector | **Included** out of the box |
| Hosting path | **Best** — embedded replicas sync to hosted Turso (clean Phase 4 route) |

**Pros:** Encryption, FTS5, and vector built in; identical sync ergonomics to better-sqlite3; in-engine path from local file → hosted/multi-user. **Cons:** Native dependency to package (prebuilt binaries per platform); pre-1.0; slightly slower local writes; Turso's newest feature work is going into its separate Rust rewrite, with libSQL in steadier maintenance.

### Option E — node:sqlite (built-in) — considered, rejected
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest — no dependency, ships with Node |
| Maturity | Experimental → RC (1.2) as of Node 25.7 (Feb 2026) |
| Encryption | **None** (would need a native SQLCipher extension — erases the zero-dep advantage) |
| FTS5 | **Not compiled into stock Node 22+** (needs `--sqlite-enable-fts5`, Node 23+) — cannot be assumed on a user's Node |
| Hosting path | None built-in |

**Pros:** Zero dependency, smallest footprint, fastest local, official runtime. **Cons:** No encryption and no FTS5 in stock builds — both are requirements here — and no hosting path. Its core advantage (zero native dependency) evaporates the moment we add SQLCipher/FTS5 extensions.

### Option F — DuckDB
Strong for analytics, weaker for transactional, idempotent single-row writes (our write path). Rejected as the primary store; could be added later purely for heavy analytics if ever needed.

## Trade-off Analysis

All SQLite-family options deliver the query features that matter (recursive CTEs, window functions, JSON). The decision turned on three requirements that do **not** hold uniformly:

- **Encryption at rest** — required for financial data. Only libSQL offers it turnkey; better-sqlite3 needs a custom SQLCipher build; node:sqlite has none.
- **FTS5** (powers `search_transactions`) — bundled by libSQL and better-sqlite3, but **absent from stock node:sqlite**, which we cannot assume on a user's installed Node.
- **Hosted multi-user path** (Phase 4) — only libSQL has it in-engine (embedded replicas → Turso).

These three converge on **libSQL**. node:sqlite's real strengths (zero dependency, top local speed, official runtime) are "simplicity now" rather than "capability," and its zero-dependency edge would be lost anyway once SQLCipher and FTS5 extensions were bolted on. The accepted costs of libSQL — a packaged native dependency, pre-1.0 status, slightly slower local writes — are immaterial at single-user scale.

On encryption specifically: at-rest encryption protects the **file** (lost/stolen device, a `.db` swept into a cloud/Time Machine backup, a shared machine), **not** a live system against active malware — anything running as the user while the server is up can read the keychain key or call the MCP directly. Full-disk encryption (FileVault/BitLocker) already covers device theft; app-level encryption adds the backup/shared-machine/compliance layer on top. It is only meaningful if the key is **not** stored beside the database — hence the OS keychain.

Dropping graph for relational is low-risk: the completed hexagonal refactor confines the blast radius to `diplomat/db` (Cypher → SQL) plus the `modelToDb`/`dbToModel` adapters. Controllers, logic, models, and the entire MCP/REST tool surface are unaffected by construction — and the same boundary keeps a future driver swap (e.g. to Turso-hosted sync) contained.

## Graph → relational mapping (sketch, not final schema)

- `:Account` / `:CreditCard` → `accounts`, `credit_cards` tables; `[:DENOMINATED_IN]` → a `currency` FK column.
- `:Transaction` → `transactions` table; `[:FROM]`/`[:TO]`/`[:CHARGED_TO]` → `from_account_id` / `to_account_id` / `credit_card_id` columns; `idempotencyKey` → `UNIQUE` column (idempotency invariant preserved).
- `[:IN]`/`[:IN_SUB]` → `category_id` / `subcategory_id` columns; `categories.parent_id` self-reference for hierarchy (recursive CTE if needed).
- `:Merchant` + `[:USUALLY {weight, origin}]` → `merchants` table + `merchant_category(merchant_id, category_id, weight, origin)` — the classifier IS this table; corrections `UPDATE` the weight (learning loop unchanged).
- `:Bill` + `[:OF]`/`[:CONTAINS]` → `bills` table + `bill_id` FK on transactions.
- `:RecurringRule` → `recurring_rules` table.
- `search_transactions` → an **FTS5** virtual table over transaction description/merchant (libSQL ships FTS5).
- Balances stay **derived** (sum query), never stored. Transfers stay `type='transfer'` with both account columns set; summary/classification queries keep excluding them (ADR-002 holds).

## Consequences

**Easier:**
- Local-only, zero-config MCP shippable via `npx` — no server, no hosted DB, no auth/multi-user work for v1.
- Encryption at rest by default for financial data, with zero-prompt UX via the OS keychain.
- FTS5-backed `search_transactions` works out of the box; per-currency summaries and correlations become standard SQL (window functions) instead of Cypher.
- A first-class Phase 4 route to hosted multi-user (embedded-replica sync) without changing engines.

**Harder / accepted costs:**
- A real, but contained, migration: rewrite `diplomat/db` repos (Cypher → SQL), update the `modelToDb`/`dbToModel` adapters and `wire/db` shapes, replace seed/constraints/indexes with SQL DDL, and swap testcontainers-Neo4j plans for an in-memory/temp-file SQLite test setup.
- Package a **native dependency** (libSQL) with prebuilt binaries across target platforms; verify `npx` install works on macOS/Windows/Linux.
- **Key management** is now load-bearing: keychain integration per OS, key generation on first run, and a documented recovery/rotation story. Encryption is only as strong as this.
- libSQL is pre-1.0 and not where Turso's newest feature work lands; watch its release cadence.
- We give up native graph traversal (not needed); the `nodes`/`edges` + recursive-CTE fallback remains if that ever changes.

**To revisit:**
- **Phase 4 hosting/multi-user:** turn the local file into a Turso-synced embedded replica (decided behind the same repo contracts, no domain changes).
- Reassess the engine if libSQL stalls relative to Turso's Rust rewrite, or promote encryption/key policy as the security model matures.

## Action Items
1. [ ] Update `docs/PLAN.md` — replace the Neo4j/graph-model sections, infra (drop the `neo4j` compose service), and risks with the local-first encrypted-SQLite plan.
2. [ ] Update `docs/architecture.md` — replace the graph model with the relational schema; update Stack, invariants (idempotency/transfers/balances restated in SQL terms), and the ADR index.
3. [ ] Update `CLAUDE.md` — data conventions and commands (remove Neo4j/Cypher guidance; add SQL/libSQL conventions, parameterized statements, FTS5 search, encryption/keychain, migration/seed approach).
4. [ ] Define the SQL DDL: tables, `UNIQUE(idempotencyKey)`, FKs, indexes (date range, merchant lookup), the FTS5 virtual table, and the idempotent seed (currencies, BR categories, merchant rules).
5. [ ] Implement encryption: enable libSQL encryption by default, key generation + OS-keychain storage (macOS/Windows/Linux), and document recovery/rotation.
6. [ ] Rewrite `diplomat/db` repos against the async `@libsql/client` + `drizzle-orm/libsql` (repos return promises; controllers' `ResultAsync` unchanged); update `adapters` (`modelToDb`/`dbToModel`) and `wire/db` schemas.
7. [ ] Replace the Neo4j integration-test setup with in-process libSQL (temp-file/`:memory:`): rewrite `test/integration/setup.ts` (drop `@testcontainers/neo4j` / `Neo4jContainer`) and `test/integration/server-setup.ts` (libSQL client factory instead of `createDriver`/`waitForNeo4j`/`bootstrap`); keep the classifier golden set.
8. [ ] Update the CI pipeline (`.github/workflows/ci.yml`): integration tests no longer need Docker/Neo4j — they run in-process; drop the testcontainers dependency and simplify the integration job accordingly.
9. [ ] Package for `npx` (bin entry, libSQL prebuilt binaries per platform, Node version baseline) for the first local release.
