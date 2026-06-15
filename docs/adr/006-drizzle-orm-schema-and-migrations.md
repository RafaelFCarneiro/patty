# ADR-006: Drizzle ORM for schema definition and migrations

**Status:** Accepted · **Date:** 2026-06-15 · Companion to ADR-004 (libSQL as the persistence engine).

## Context

ADR-004 chose libSQL as the SQLite engine. That decision left open how to manage the schema itself: raw SQL strings in `bootstrap.ts`, a standalone migration runner, or a higher-level ORM. Three concerns drove this follow-on decision:

1. **Schema drift risk** — raw `CREATE TABLE IF NOT EXISTS` strings have no mechanism to detect or apply changes after the initial creation. A new column added in code would never appear in an existing database without a separate migration.
2. **Type safety** — hand-written `wire/db` zod schemas duplicate the column definitions. A column rename or type change needs to be updated in two places independently.
3. **Parameterized query ergonomics** — the existing Cypher code already enforced parameterization. The SQL equivalent must be equally easy to enforce; raw `db.prepare()` strings are correct but tedious to audit.

## Decision

Use **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) for:

1. **Schema definition** — tables defined once in TypeScript (`src/diplomat/db/schema.ts`); column types, enums, FK references, and CHECK constraints are type-checked at compile time.
2. **Migration generation** — `npx drizzle-kit generate` diffs the TypeScript schema against the previous snapshot and emits a versioned SQL file in `drizzle/`. No SQL is written by hand for standard DDL changes.
3. **Runtime migration** — `migrate(db, { migrationsFolder })` in `bootstrap()` applies pending migrations on every server start; the `__drizzle_migrations` table tracks applied files.
4. **Query builder** — repos use the Drizzle query builder (`db.select().from(...).where(...)`) for type-safe, parameterized queries. Raw `db.prepare()` is reserved for features Drizzle cannot express (FTS5 MATCH, `changes()`, `last_insert_rowid()`).

The FTS5 virtual table and its sync triggers, which drizzle-kit cannot generate, live in a hand-written migration file (`drizzle/0001_fts5_search.sql`) alongside the generated files — applied by the same `migrate()` call.

The `drizzle/` folder (migration SQL + meta snapshots) is **committed to the repository**. Migration files are read by `migrate()` at runtime; the snapshot files are read by drizzle-kit when generating the next migration. Neither is a build artifact.

## Options Considered

### Option A — Raw SQL strings (status quo from initial bootstrap draft)

`db.exec(DDL)` with `CREATE TABLE IF NOT EXISTS` strings; seed via parameterized `db.prepare()`.

**Pros:** Zero dependency; no tooling to learn.  
**Cons:** No versioned migrations — `IF NOT EXISTS` only creates, never alters; schema drift is silent. No type inference from column definitions. Every column definition duplicated between DDL string and zod schemas.

### Option B — Lightweight migration runner (e.g. `better-sqlite3-migrations`)

Numbered `.sql` files applied in order; no schema definition layer.

**Pros:** SQL stays as SQL; minimal dependency.  
**Cons:** No TypeScript schema → still need separate zod schemas; no query builder → parameterization discipline is per-file rather than enforced by the API.

### Option C — Drizzle ORM — **chosen**

TypeScript schema → generated SQL migrations → type-safe query builder.

**Pros:** Single source of truth for column shapes (Drizzle schema → inferred types used in wire/db); versioned migrations with automatic diffing; query builder enforces parameterization structurally (values are never string-concatenated); first-class libSQL support.  
**Cons:** Additional dependency (prod: `drizzle-orm`; dev: `drizzle-kit`); `@types/better-sqlite3` required at compile time since `libsql` is API-compatible but does not re-export those types; FTS5 virtual tables require a manual migration file.

### Option D — Prisma

Mature, widely adopted ORM with its own migration system.

**Pros:** Excellent DX, strong community.  
**Cons:** Prisma Client generates a large runtime artifact; its SQLite support is less ergonomic than Drizzle's for synchronous use; no first-class libSQL/Turso path that matches ADR-004's Phase 4 hosting route.

## Trade-off Analysis

The key constraint from ADR-004 is the **synchronous** `libsql` driver (better-sqlite3 API). Drizzle is the only ORM with documented, first-class support for this exact combination — and it is Turso's own recommended ORM, so the synchronous libSQL ↔ Drizzle path is tested and maintained.

The `@types/better-sqlite3` compile-time dependency is a minor wart: it satisfies the `drizzle-orm/better-sqlite3` type imports, while the actual runtime implementation is provided by `libsql` (which ships its own prebuilt native binary). This asymmetry is intentional and documented in `driver.ts`.

Drizzle's query builder does not prevent raw SQL — `db.run(sql`...`)` remains available and is used where needed (FTS5 MATCH, `changes()`). The parameterization invariant from `docs/architecture.md` and `docs/code-quality.md` is upheld: Drizzle's API makes parameterization the path of least resistance, and the raw escape hatch is only used where the builder cannot express the query.

## Consequences

- **Schema changes**: edit `schema.ts` → run `npx drizzle-kit generate` → commit the new `.sql` file. No hand-written DDL for standard table changes.
- **Type safety**: `typeof table.$inferSelect` and `typeof table.$inferInsert` replace hand-written `wire/db` row types for all tables covered by the Drizzle schema.
- **FTS5 exception**: virtual tables and their triggers remain in `drizzle/0001_fts5_search.sql` as a permanent manual migration; drizzle-kit will never overwrite it.
- **Blast radius unchanged**: Drizzle lives entirely inside `diplomat/db`; controllers and logic remain DB-agnostic.
- **Phase 4 path**: when libSQL embedded-replica sync is enabled (ADR-004 Phase 4), the Drizzle schema and migrations carry over unchanged — only the driver initialization changes.
