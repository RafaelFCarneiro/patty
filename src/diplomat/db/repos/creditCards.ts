import type { Driver } from 'neo4j-driver'
import { CreditCard } from '../../../models/creditCard.js'
import { run } from '../driver.js'

type NodeLike = { properties: Record<string, unknown> }

const toCard = (record: Record<string, unknown>): CreditCard =>
  CreditCard.parse({
    ...(record['cc'] as NodeLike).properties,
    currency: record['currency'],
    limit: ((record['cc'] as NodeLike).properties['limit'] as number | null) ?? undefined,
  })

export type CreditCardsRepo = {
  list: () => Promise<CreditCard[]>
  create: (card: CreditCard) => Promise<CreditCard>
  findByName: (name: string) => Promise<CreditCard | null>
}

export const creditCardsRepo = (driver: Driver): CreditCardsRepo => ({
  list: async () => {
    const rows = await run(
      driver,
      `MATCH (cc:CreditCard)-[:DENOMINATED_IN]->(cur:Currency)
       RETURN cc, cur.code AS currency ORDER BY cc.name`,
    )
    return rows.map(toCard)
  },

  create: async (card) => {
    const rows = await run(
      driver,
      `MATCH (cur:Currency {code: $currency})
       CREATE (cc:CreditCard {id: $id, name: $name, closingDay: $closingDay, dueDay: $dueDay, limit: $limit})
       MERGE (cc)-[:DENOMINATED_IN]->(cur)
       RETURN cc, cur.code AS currency`,
      { ...card, limit: card.limit ?? null },
    )
    return toCard(rows[0]!)
  },

  findByName: async (name) => {
    const rows = await run(
      driver,
      `MATCH (cc:CreditCard)-[:DENOMINATED_IN]->(cur:Currency)
       WHERE toLower(cc.name) = toLower($name)
       RETURN cc, cur.code AS currency LIMIT 1`,
      { name },
    )
    return rows[0] ? toCard(rows[0]) : null
  },
})
