# ADR-002: Transfers are Transactions with type 'transfer'

**Status:** Accepted · **Date:** 2026-06-11 · Supersedes the `:Transfer` node introduced earlier the same day.

## Context

Transfers were first modeled as a separate `:Transfer` node so spending summaries could never be polluted by construction. Review surfaced the cost: the account statement history (extrato) — the primary reconciliation surface — becomes a UNION of two structures, and every history/reconciliation feature (search, export, bank-statement matching, update/delete tooling, idempotency) must be built twice or merged at read time, forever.

## Decision

A transfer is a `:Transaction {type: 'transfer'}` carrying both `[:FROM]->(:Account)` and `[:TO]->(:Account)` edges. `TransactionType` becomes `expense | income | transfer`.

## Consequences

- **Unified extrato**: one query lists an account's complete movement history; reconciliation tools see one structure. `search_transactions` covers transfers (`type: 'transfer'`), and account filtering matches either side.
- **Uniform tooling**: idempotency, update, delete, getById work on transfers with zero extra code.
- **Filter discipline replaces structural safety**: spending summaries and classification must exclude `type = 'transfer'` explicitly (`WHERE t.type <> 'transfer'`). This is the accepted risk — enforced in code review and covered by the summary unit tests.
- Transfers are never classified (no category, no merchant edge) and remain same-currency until FX lands.
- `create_transfer` stays as the ergonomic MCP tool (resolves both accounts, validates currency match); `list_transfers` is dropped in favor of `search_transactions`.
- Balance derivation reads one structure: outflow = `FROM` edges (expense + transfer), inflow = income + `TO` edges.
