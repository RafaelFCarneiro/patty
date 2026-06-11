# ADR-001: Use neverthrow for Result types

**Status:** Accepted · **Date:** 2026-06-09

## Context

The diplomat/FP architecture requires explicit handling of expected failures (unknown account, ambiguous category, duplicate idempotency key) as values, not exceptions. Candidates: `neverthrow` (focused Result/ResultAsync library) and `fp-ts` (full FP ecosystem: Either, TaskEither, pipe, type classes).

## Decision

Use **neverthrow**.

## Rationale

- The codebase needs exactly one abstraction: `Result<T, AppError>`. neverthrow provides it with a small, readable API (`ok`, `err`, `map`, `andThen`, `match`) that any TS developer can pick up in minutes.
- fp-ts brings HKT encodings, steep onboarding, and an idiom shift (pipe-everything) that would dominate code review attention without adding capability we need. fp-ts is also in maintenance transition (Effect), making it a riskier dependency.
- Convention: controllers return `Result<T, AppError>` for expected failures; unexpected errors throw. `logic/` functions return plain values or `Result` where failure is part of the domain.

## Consequences

- No `pipe`/`flow` composition idioms; plain function composition and `andThen` chains.
- If we ever need structured concurrency/effects, revisit with Effect as a separate ADR.
