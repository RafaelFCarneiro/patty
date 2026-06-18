# Feature designs

Design docs for **features** — a capability, the options considered, the trade-offs, and the plan.
They are a technical assessment, not architectural law.

**Feature design vs. ADR**

- `docs/adr/` — **architectural decisions**: cross-cutting, hard-to-reverse choices that constrain the whole
  system (e.g. the Result library, the persistence engine, the diplomat layering, the MCP transport).
- `docs/designs/` — **feature designs**: a specific capability and how it's built. May include implementation
  detail. Numbered independently (`001-…`, `002-…`).

A feature design may *produce* a durable invariant (e.g. "balances are effective-only"). When that happens,
the invariant is recorded in `docs/architecture.md` at implementation time — `architecture.md` remains the
single source of truth for the system as built; the design doc is the reasoning behind it.

**Each design doc is self-contained.** It ends with an **`## Implementation prompt`** section — the execution
guide a coding agent follows to build the feature. To kick off implementation, point the agent at the doc:
*"Implement the feature in `docs/designs/NNN-…md` — follow its Implementation prompt."*

**Each doc carries an Implementation status** in its header — delivery state, distinct from the design's
acceptance: `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates it (→ `In progress`
when work starts, → `Done` on merge; `Blocked` + a one-line reason if stuck). At a glance, the header tells you
whether a feature is built.
