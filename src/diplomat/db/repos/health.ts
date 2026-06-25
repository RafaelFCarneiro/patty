import { sql } from 'drizzle-orm'
import type { Db } from '../driver.js'

export type HealthRepo = { reachable: () => Promise<boolean> }

export const healthRepo = (db: Db): HealthRepo => ({
  reachable: async () => {
    await db.run(sql`SELECT 1`)
    return true
  },
})
