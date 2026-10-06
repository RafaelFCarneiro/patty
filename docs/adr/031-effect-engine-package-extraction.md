# ADR-031: Lift `src/effects/` into its own repository + package; FinTrack consumes it as a dependency

**Status:** Accepted (FinTrack consumption landed on `refactor/consume-effects-package`; package published as `@rfc0/effect-runner@0.2.0`) · **Date:** 2026-09-23 · **Deciders:** Rafael · Executes the **deferred destination** of
ADR-030 (and the north star of ADR-029/030): the effect engine becomes its **own project — a standalone
library** FinTrack depends on, so FinTrack sheds the engine's structure/responsibility and keeps only its actual
purpose, **financial management**. Cross-repo: this ADR is a runbook spanning a **new repository** and a FinTrack
consumption branch, not a single FinTrack PR.

## Context

`src/effects/` is already a self-contained, **driver-and-FinTrack-free** module (ADR-030): 323 lines
(`engine.ts` — `runEffects`/`runEffectsSequence`, the adapter port, `VersionConflict`, the retry loop;
`persistable.ts` — `Persistable`/`PersistOutcome`/`FlowOutcome`/`PersistenceMeta`/`withPersistenceMeta`/
`INITIAL_VERSION`), importing only `zod`/`neverthrow`/`remeda`, with an `eslint.config.js` rule failing any
driver/FinTrack import. Because the boundary already holds and is build-enforced, the lift-out is a **move, not a
rewrite** — exactly as ADR-030 intended.

We are doing this while FinTrack is still the **sole consumer** — a deliberate choice for the reuse/portability
goal (a future Postgres adapter, other projects), accepting the tradeoff below rather than waiting for a second
consumer.

## Decision

Extract `src/effects/` into a **new repository published as a package**; FinTrack adds it as a dependency,
rewrites its ~35 `../effects/…` imports to the package, and **deletes `src/effects/`**. The package's **public
API is the port + the data contract** — that surface is what semver governs.

### Package identity

- **Name:** **`@rfc0/effect-runner`** — scoped under the dedicated `@rfc0` npm organization (the engine first shipped as `@rafaelfcarneiro/effect-runner` 0.1.x, then moved here because npm cannot transfer packages between scopes; that package is deprecated), domain-neutral
  (it is a generic FC/IS effect runner with optimistic-concurrency + idempotency, not a finance library),
  **published public** on npmjs.com (`npm publish --access public`).
- **Exports:** the two modules' public surface (`runEffects`/`runEffectsSequence`, the port types
  `TransactionRunner`/`EntityApplier`/`ApplierRegistry`/`ReadBack`/`IsTransientContention`, `VersionConflict`,
  `MAX_RUN_EFFECTS_ATTEMPTS`, and the `Persistable`/`PersistenceMeta`/`withPersistenceMeta`/`INITIAL_VERSION`
  contract). ESM, `"type": "module"`, Node 22, `.d.ts` emitted (tsc), **MIT** — the engine ships MIT as a
  permissive open-source library, a deliberate divergence from FinTrack's Apache-2.0 (FinTrack, the consumer,
  stays Apache-2.0; MIT on the lib maximizes downstream reuse).
- **Dependencies:** `neverthrow`, `remeda` as deps; **`zod` as a `peerDependency`** (a single zod instance must
  be shared with the consumer — two copies break schema/`instanceof` identity). No DB driver, ever (the lint
  rule travels with the package).

### Test split

- **Moves to the new repo:** `test/unit/effects/*` — the pure engine tests (retry/orchestration against a fake
  runner + fake appliers). They need no database.
- **Stays in FinTrack:** `test/integration/db/effects.test.ts` — it exercises `versionedTableApplier` against
  libSQL, i.e. the **SQLite adapter implementing the port**, which lives in FinTrack, not in the package.

### Consumption mechanism (decided)

**Publish public on npmjs.com** (`npm publish --access public`), semver from `v0.1.0`. FinTrack depends on the
published package by version range. This is a deliberate step toward an **open-source** posture for the engine —
the git-dependency shortcut is **not** used; the package is a first-class public artifact from the start. (The
one caveat the publish-now path accepts: the port's public API is shaped by a single consumer today, so expect a
`0.x` line where minor bumps may still adjust the surface before `1.0`.)

## Options considered

- **Separate repo + package (chosen).** Matches the stated north star (the engine as its own project); FinTrack
  becomes a pure consumer. Cost: a second repo to maintain + a release step for engine changes (below).
- **npm workspace / monorepo in the FinTrack repo (rejected).** Lighter (one repo, one CI), and it would give the
  package boundary — but it does **not** achieve "the engine is its own project," which is the explicit goal.
  Noted as the fallback if the two-repo overhead proves not worth it.
- **Keep the internal `src/effects/` module (rejected).** ADR-030's state; the user is deliberately moving past it.
- **Git dependency instead of publishing (considered, not chosen).** Would avoid registry ceremony while FinTrack
  is the sole consumer — but Rafael is adopting an **open-source** posture for the engine, so publishing public
  on npm from `v0.1.0` is the point, not overhead. The accepted cost is a `0.x` line while the single-consumer
  API settles.

## Consequences

- **FinTrack sheds the engine** (~323 lines + `test/unit/effects/`) and its responsibility; `package.json` gains
  one dependency; the `src/effects/**` lint rule is removed (the boundary is now the package boundary). The
  architecture dependency table + write-path doc point at the package instead of `src/effects/`.
- **Slower engine iteration — the real tradeoff.** An engine change is now: change in the package repo →
  version bump → `npm publish` → bump FinTrack's dependency → verify. With a single consumer that publish round-
  trip is pure overhead; accepted deliberately for the open-source + externalization/reuse payoff. (A `0.x` line
  keeps the API adjustable while it settles.)
- **The port becomes a versioned public API.** Breaking the `EntityApplier`/`TransactionRunner`/`Persistable`
  surface is now a semver-major of the package, not an in-repo refactor. This is the discipline the split buys.
- **The change bus ships in the package too** (0.3.0): FinTrack's own `diplomat/changeBus.ts` is deleted; the package bus
  isolates subscriber failures (bus `onError`) and the engine's `onPublishError` backstops a throwing publish, so a
  notification can never fail a committed write.
- **3b (Postgres) later** implements the package's port — in FinTrack or its own adapter package — without
  touching the engine repo.

## Migration plan (cross-repo runbook — the two halves land in different repositories)

1. **New repo (`<pkg>`), outside FinTrack.** Seed it from `src/effects/` verbatim + scaffolding: `package.json`
   (name, ESM, exports, `zod` peer, `neverthrow`/`remeda` deps, build script), `tsconfig` (emit ESM + `.d.ts`),
   the ported `eslint.config.js` driver/FinTrack-import ban, `test/unit/effects/*` moved in, a README documenting
   the port, LICENSE. Green gate; tag `v0.1.0`. _(Repo creation + tag/publish are done by Rafael — outside this
   session's reach; I can scaffold every file for seeding.)_
2. **FinTrack branch `refactor/consume-effects-package`.** Add the published dependency
   (`@rfc0/effect-runner`, a `^0.2.0` range);
   rewrite the ~35 `../effects/…` imports across `models/`/`controllers/`/`logic/`/`adapters/`/`diplomat/db` to
   the package; **delete `src/effects/`** and `test/unit/effects/`; keep `test/integration/db/effects.test.ts`
   (adapter test); remove the `src/effects/**` eslint block; update `docs/architecture.md` (dependency table + ADR
   index), `docs/write-path.md` (engine now an external package), `CLAUDE.md`/copilot layer rule. Green gate.
   Behavior-preserving — same engine, now imported.

## Action Items

1. [x] Decided: name **`@rfc0/effect-runner`**; **published public on npmjs.com**; **MIT** (lib
   diverges from FinTrack's Apache-2.0 for max reuse); `zod` as `peerDependency`.
2. [x] Scaffolded and published the new package (`RafaelFCarneiro/effect-runner`, npm trusted publishing + staged approval; `0.2.0` live under `@rfc0`).
3. [x] FinTrack `refactor/consume-effects-package` — depend on the package, rewrite imports, delete `src/effects/`,
   drop the lint block, update docs. DoD + subagent verification (behavior unchanged; no `src/effects/` left).
4. [ ] Toward `1.0` — once the port's public API has held across a real second consumer (e.g. a Postgres
   adapter), cut `@rfc0/effect-runner@1.0.0` and pin FinTrack to the stable major.

This is feature-sized on the FinTrack side (multi-layer import rewrite + a deletion + docs) → independent
verification subagent, charged with confirming no `src/effects/` reference survives, imports resolve to the
package, the adapter test still passes, and behavior is unchanged.
