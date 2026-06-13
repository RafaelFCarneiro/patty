# Tech Debt

Known trade-offs consciously deferred during feature development. Each entry has enough context to be picked up cold.

---

## TD-001 — Tag filter runs after OPTIONAL MATCH row expansion in `search_transactions`

**File:** `src/diplomat/db/repos/transactions.ts` — `transactionsRepo.search`

**Category:** Performance / Query efficiency

**Priority:** Low (correctness is not affected; scale is a personal finance app)

### What the current code does

The search query expands all optional relationships first (account, card, category, merchant, tags) via `MATCH_REFS`, then applies the tag filter in the `WHERE` clause using a pattern comprehension:

```cypher
MATCH (t:Transaction)
OPTIONAL MATCH (t)-[:FROM]->(a:Account)
-- ... other optional matches ...
OPTIONAL MATCH (t)-[:TAGGED_WITH]->(tag:Tag)
WITH t, a, ta, cc, c, m, tag, true AS created
WHERE ...
  AND (size($tagNames) = 0 OR size([(t)-[:TAGGED_WITH]->(ft:Tag) WHERE ft.name IN $tagNames | 1]) > 0)
RETURN ..., collect(DISTINCT tag.name) AS tags, ...
```

Because the `OPTIONAL MATCH` on `tag` multiplies rows (one per tag per transaction), the filter predicate is re-evaluated once per row. The pattern comprehension also allocates an intermediate list on every evaluation.

### What it should do

Apply the tag existence check **before** expanding optional matches, using an `EXISTS {}` subquery:

```cypher
MATCH (t:Transaction)
WHERE ($from IS NULL OR t.date >= $from)
  -- ... scalar filters ...
  AND (size($tagNames) = 0 OR EXISTS {
        MATCH (t)-[:TAGGED_WITH]->(ft:Tag) WHERE ft.name IN $tagNames
      })
OPTIONAL MATCH (t)-[:FROM]->(a:Account)
-- ... other optional matches ...
OPTIONAL MATCH (t)-[:TAGGED_WITH]->(tag:Tag)
WITH t, a, ta, cc, c, m, tag, true AS created
RETURN ..., collect(DISTINCT tag.name) AS tags, ...
```

This way Neo4j filters transactions first, then expands relationships only for matching rows — reducing row multiplication and avoiding the intermediate list allocation.

### Why it was deferred

The current implementation is **correct**. For a personal finance app with hundreds to low thousands of transactions per user, the performance difference is negligible. The restructuring was flagged in [PR #4](https://github.com/RafaelFCarneiro/fintrack/pull/4) review but explicitly deferred to avoid scope creep.

### When to tackle it

- If query latency on `search_transactions` becomes noticeable (>200ms on typical datasets)
- Before any multi-user / shared-account features land, as transaction volumes could grow by orders of magnitude
- Alongside any broader Cypher query audit

### Effort estimate

Small — isolated change to a single query string in `transactionsRepo.search`. No interface changes required. Should add a search benchmark test to verify the improvement.
