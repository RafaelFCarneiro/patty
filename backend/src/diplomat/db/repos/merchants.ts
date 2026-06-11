import type { Driver } from 'neo4j-driver'
import { z } from 'zod'
import type { MerchantMatch } from '../../../logic/classify.js'
import { run } from '../driver.js'

const MatchRow = z.object({
  merchantKey: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  weight: z.number(),
  origin: z.enum(['rule', 'graph']),
})

export type MerchantsRepo = {
  /** Find merchant→category candidates whose key appears in the normalized description. */
  matchCandidates: (normalizedDescription: string) => Promise<MerchantMatch[]>
}

export const merchantsRepo = (driver: Driver): MerchantsRepo => ({
  matchCandidates: async (normalizedDescription) => {
    const rows = await run(
      driver,
      `MATCH (m:Merchant)-[u:USUALLY]->(c:Category)
       WHERE $desc CONTAINS m.key
       RETURN m.key AS merchantKey, c.id AS categoryId, c.name AS categoryName,
              u.weight AS weight, coalesce(u.origin, 'graph') AS origin
       ORDER BY u.weight DESC, size(m.key) DESC
       LIMIT 5`,
      { desc: normalizedDescription },
    )
    return rows.map((r) => MatchRow.parse(r))
  },
})
