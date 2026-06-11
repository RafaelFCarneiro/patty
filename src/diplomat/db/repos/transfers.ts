import type { Driver } from 'neo4j-driver'
import { Transfer } from '../../../models/transfer.js'
import { run } from '../driver.js'

type NodeLike = { properties: Record<string, unknown> }

const toTransfer = (record: Record<string, unknown>): Transfer => {
  const p = (record['tr'] as NodeLike).properties
  return Transfer.parse({
    ...p,
    description: p['description'] ?? undefined,
    fromAccountId: record['fromAccountId'],
    fromAccountName: record['fromAccountName'],
    toAccountId: record['toAccountId'],
    toAccountName: record['toAccountName'],
  })
}

const RETURN_TR = `
  RETURN tr, fa.id AS fromAccountId, fa.name AS fromAccountName,
         ta.id AS toAccountId, ta.name AS toAccountName, created`

export type TransfersRepo = {
  create: (props: {
    id: string
    amount: number
    date: string
    currency: string
    description: string | null
    idempotencyKey: string
    fromAccountId: string
    toAccountId: string
  }) => Promise<{ transfer: Transfer; created: boolean }>
  list: (filters: { from: string | null; to: string | null; accountId: string | null }) => Promise<Transfer[]>
}

export const transfersRepo = (driver: Driver): TransfersRepo => ({
  /** Idempotent like transactions: MERGE on idempotencyKey, edges only on first write. */
  create: async (props) => {
    const rows = await run(
      driver,
      `MERGE (tr:Transfer {idempotencyKey: $idempotencyKey})
       ON CREATE SET tr += $props, tr._new = true
       WITH tr, coalesce(tr._new, false) AS created
       REMOVE tr._new
       WITH tr, created
       MATCH (from:Account {id: $fromAccountId})
       MATCH (to:Account {id: $toAccountId})
       FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
         MERGE (tr)-[:FROM]->(from)
         MERGE (tr)-[:TO]->(to))
       WITH tr, created
       MATCH (tr)-[:FROM]->(fa:Account)
       MATCH (tr)-[:TO]->(ta:Account)
       ${RETURN_TR}`,
      {
        idempotencyKey: props.idempotencyKey,
        fromAccountId: props.fromAccountId,
        toAccountId: props.toAccountId,
        props: {
          id: props.id,
          amount: props.amount,
          date: props.date,
          currency: props.currency,
          description: props.description,
          idempotencyKey: props.idempotencyKey,
        },
      },
    )
    const row = rows[0]!
    return { transfer: toTransfer(row), created: Boolean(row['created']) }
  },

  list: async (filters) => {
    const rows = await run(
      driver,
      `MATCH (tr:Transfer)-[:FROM]->(fa:Account), (tr)-[:TO]->(ta:Account)
       WITH tr, fa, ta, true AS created
       WHERE ($from IS NULL OR tr.date >= $from)
         AND ($to IS NULL OR tr.date < $to)
         AND ($accountId IS NULL OR fa.id = $accountId OR ta.id = $accountId)
       ${RETURN_TR}
       ORDER BY tr.date DESC`,
      filters,
    )
    return rows.map(toTransfer)
  },
})
