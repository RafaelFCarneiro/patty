# ADR-001: Use neverthrow for Result types

**Status:** Accepted (reaffirmed 2026-06-11) · **Date:** 2026-06-09

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

## Reaffirmation (2026-06-11)

Challenged after Phase 1 with the argument that neverthrow is "about exceptions" while fp-ts suits a strictly functional backend (npm trends comparison: effect 19.4M weekly downloads, ramda 14.5M, fp-ts 5.2M, neverthrow 2.0M).

Decision held, on three grounds:

1. **Mischaracterization**: neverthrow is errors-as-values (Railway-Oriented Programming), not exception tooling. Our usage — `ok/err/match` over typed domain outcomes like `unknown_account` — is precisely FP error handling; `fromThrowable` is barely used.
2. **fp-ts is sunsetting**: in maintenance mode and officially merging into Effect; adopting it in 2026 means adopting a legacy library. The real alternative is Effect.
3. **Effect is a framework commitment**: it would also replace our `Deps` injection (Layers), add retries/concurrency/observability — valuable for Phase 4 importers, but it rewrites controller/diplomat idioms and steepens onboarding. The diplomat architecture derives its FP-ness from layer purity, not typeclasses; neverthrow is right-sized today.

Ramda was also considered and rejected as orthogonal (data transformation, weak TS inference); native array methods suffice in `logic/`, with remeda as the typed option if needed.

**Trigger to revisit**: when bank-sync importers (Phase 4) need typed retries, structured concurrency, or richer dependency wiring — write ADR for Effect migration then.
