# Feature Design 019: Guided-workflow MCP prompts — monthly_review, budget_checkup, import_statement

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Done · **Date:** 2026-07-25 · PLAN Phase 3 (MCP prompts + skills). The **first
MCP prompts** in the server. Orchestration-only — no entity, no query, no write flow of its own; the prompts
instruct the model to call tools that already exist.

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`. **One PR**:
> `feat/mcp-workflow-prompts`.

## Context

The tools are all built; what's missing is the *one-word experience* that ties them into a narrative — "run my
monthly review" instead of the user (or agent) remembering to call summary + `find_correlations` +
`get_budget_status` and synthesise them. MCP **prompts** are the right mechanism: server-side parameterised
templates (`server.registerPrompt(name, meta, handler)` → `{ messages }`), **portable to any MCP client** and
versioned with the server. The workflows are exactly "call these tools and narrate," which a prompt template
expresses directly.

**This subsumes the PLAN's "skills" line** (monthly-review, import-statement): a Claude `SKILL.md` for these would
restate the same tool orchestration, Claude-specifically. Chosen: MCP prompts, not skills (recorded here so the
PLAN's redundant skills entry is deliberately closed, not forgotten).

## Decision

Register three prompts (`server.registerPrompt`, the first in `buildMcpServer`), with the template text in a new
`src/diplomat/mcp/prompts.ts` (keeps prose out of `server.ts`, mirroring how the dashboard seed HTML lives in its
own module). Each is **per-currency-aware** — the narrative never sums across currencies (the standing
invariant).

1. **`monthly_review({ month?, year? })`** (default: current period). Instructs: read `get_spending_summary`,
   `find_correlations(spending_shifts)`, `find_correlations(budget_fit)`, `find_correlations(recurring_candidates)`,
   and `get_budget_status` for the period; synthesise a tight narrative — income/expenses/balance **per
   currency**, the biggest shifts vs baseline and what's driving them, budget fit (on-track / over / generous),
   and any recurring candidates worth automating. Concise, no raw table dumps.
2. **`budget_checkup({ month?, year? })`**. Instructs: read `get_budget_status` + `find_correlations(budget_fit)`;
   report which budgets are on track, over, or generous, surface each `suggestedLimit` and any unbudgeted
   significant spend, and **offer to apply** — the model calls `update_budget` / `create_budget` on the user's
   say-so (the mode already returns budget ids + suggested limits for exactly this).
3. **`import_statement({ source? })`** (`source`: `card | account`, optional). Instructs: ask for the pasted
   statement text (and card-vs-bank if `source` absent), call `import_card_statement` or
   `import_account_statement`, then report created / duplicate / needs-review counts and walk the low-confidence
   (`needs_review`) items with the user for confirmation/correction.

**Mechanics:** `argsSchema` is a zod raw shape (like `inputSchema.shape` on tools); the handler returns
`{ messages: [{ role: 'user', content: { type: 'text', text } }] }` with `month`/`year` interpolated. No DB
access, no controller — the prompt is text; the *model* executes the tools (with the user in the loop for the
writes `import_statement`/`budget_checkup` may trigger).

Draft skeletons (final wording in `prompts.ts`):

> **monthly_review** — "You are reviewing the user's finances for {month}/{year}. Call `get_spending_summary`,
> `find_correlations` (`spending_shifts`, then `budget_fit`, then `recurring_candidates`), and
> `get_budget_status` for that period. Then write a brief review: per-currency income/expenses/balance; the 2–3
> biggest category shifts vs the baseline and a plausible driver; budgets that are over or slack; and any
> recurring-payment candidates worth turning into a rule. Group every figure by currency — never sum across
> currencies. Prefer prose over tables."

## Options / decisions

- **MCP prompts, not Claude skills (chosen, per decision)** — portable, server-side, no duplication; skills would
  restate the same orchestration.
- **Three distinct prompts (chosen)** vs one prompt with a `workflow` discriminator — unlike `find_correlations`
  (which shares one query surface), these are three unrelated verbs with different args; separate prompts read
  cleaner to a client's prompt picker.
- **Template text in `prompts.ts` (chosen)** — keeps `server.ts` registration thin; the prose is the deliverable
  and deserves its own home (like the dashboard seed).

## Docs to update

- `docs/mcp-tools.md` (or `docs/mcp-clients.md`) — the three prompts: names, arguments, what each orchestrates.
- `docs/PLAN.md` — Phase 3 prompts done; note skills subsumed by prompts (the redundant line closed).
- `docs/architecture.md` — a one-liner that the MCP surface now includes prompts (orchestration templates, no new
  data path).

## Testing

Prompts are model-facing text, so tests are light and structural (not behavioural):

- Each prompt registers and appears in the server's prompt list.
- Argument interpolation: `monthly_review({ month: 3, year: 2026 })` produces a message mentioning 03/2026;
  omitted args default to the current period (via `deps.clock()`).
- Handler returns a well-formed `{ messages }` with non-empty text.

## Implementation prompt

One PR, behind the full gate. First `registerPrompt` calls in `src/diplomat/mcp/server.ts`; template text in a
new `src/diplomat/mcp/prompts.ts`.

- `monthly_review` / `budget_checkup` (`{ month?, year? }`, default current period from `deps.clock()`),
  `import_statement` (`{ source? }`).
- Handlers return `{ messages: [{ role: 'user', content: { type: 'text', text } }] }`; per-currency-aware prose;
  interpolate the period.
- Docs (`docs/mcp-tools.md`, PLAN — mark prompts done and skills subsumed, `docs/architecture.md` one-liner).

### Finish (every push)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing.
