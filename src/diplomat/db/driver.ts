import neo4j, { type Driver } from 'neo4j-driver'
import type { Config } from '../../config.js'

export const createDriver = (config: Config): Driver =>
  neo4j.driver(config.NEO4J_URI, neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD), {
    disableLosslessIntegers: true,
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Neo4j may still be booting when the backend starts — retry connectivity. */
export const waitForNeo4j = async (driver: Driver, attempts = 20, delayMs = 2000): Promise<void> => {
  for (let i = 1; i <= attempts; i++) {
    try {
      await driver.verifyConnectivity()
      return
    } catch (e) {
      if (i === attempts) throw e
      console.log(`neo4j not ready (attempt ${i}/${attempts}), retrying…`)
      await sleep(delayMs)
    }
  }
}

/** Run a single query in an auto-commit session. */
export const run = async (
  driver: Driver,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> => {
  const session = driver.session()
  try {
    const result = await session.run(cypher, params)
    return result.records.map((r) => r.toObject() as Record<string, unknown>)
  } finally {
    await session.close()
  }
}
