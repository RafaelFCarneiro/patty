# ADR-003: Remeda for declarative data transformation in logic/

**Status:** Accepted · **Date:** 2026-06-11 · Complements ADR-001 (neverthrow).

## Context

Review found `logic/` functions written imperatively (filter/reduce chains, manual grouping) where declarative pipelines would be clearer. Candidates: Ramda (weak TS inference, point-free style fights TS), lodash/fp (legacy typings), Remeda (TS-first, data-first AND data-last `pipe` support, tree-shakeable, lazy evaluation where it matters, actively maintained).

## Decision

Use **Remeda** in `logic/` (and adapters) for data transformation: `pipe`, `groupBy`, `sortBy`, `sumBy`, `countBy`, `firstBy`, etc.

## Scope boundary (important)

Each library owns one concern — do not cross them:

- **zod** — schemas and boundary decoding.
- **neverthrow** — control flow for fallible operations (`Result`, `andThen`, `match`). The sequential resolve-then-act shape of controllers is *control flow*, not data transformation: keep it in neverthrow idioms (or readable awaits), don't force Remeda pipes there.
- **remeda** — pure data reshaping: grouping, aggregating, sorting, picking.

Native array methods remain fine for trivial cases (single `map`/`filter`). Reach for Remeda when the transformation has ≥2 stages or needs grouping/aggregation.

## Consequences

- `summarize`, `pickClassification`, and bulk-result counting become declarative pipelines.
- Bundle impact negligible (tree-shakeable, server-side anyway).
- Revisit only if Effect adoption (ADR-001 trigger) ever subsumes this layer.
