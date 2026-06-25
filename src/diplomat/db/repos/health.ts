import { sql } from 'drizzle-orm'
import type { Db } from '../driver.js'

export type HealthRepo = { reachable: () => Promise<void> }

export const healthRepo = (db: Db): HealthRepo => ({
  reachable: async () => {
    await db.all(sql`SELECT 1`)
  },
})
