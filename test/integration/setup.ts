import { randomUUID } from 'node:crypto'
import type { StartedNeo4jContainer } from '@testcontainers/neo4j'
import { Neo4jContainer } from '@testcontainers/neo4j'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { bootstrap } from '../../src/diplomat/db/bootstrap.js'
import { createDriver, waitForNeo4j } from '../../src/diplomat/db/driver.js'
import { accountsRepo } from '../../src/diplomat/db/repos/accounts.js'
import { billsRepo } from '../../src/diplomat/db/repos/bills.js'
import { categoriesRepo } from '../../src/diplomat/db/repos/categories.js'
import { subCategoriesRepo } from '../../src/diplomat/db/repos/subCategories.js'
import { creditCardsRepo } from '../../src/diplomat/db/repos/creditCards.js'
import { merchantsRepo } from '../../src/diplomat/db/repos/merchants.js'
import { recurringRepo } from '../../src/diplomat/db/repos/recurring.js'
import { tagsRepo } from '../../src/diplomat/db/repos/tags.js'
import { transactionsRepo } from '../../src/diplomat/db/repos/transactions.js'
import { registerRoutes } from '../../src/diplomat/http/routes.js'
import { registerMcpRoute } from '../../src/diplomat/mcp/route.js'

const TEST_PORT = 3099

let container: StartedNeo4jContainer
let app: FastifyInstance

export const setup = async () => {
  container = await new Neo4jContainer('neo4j:5-community').start()

  const driver = createDriver({
    NEO4J_URI: container.getBoltUri(),
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: container.getPassword(),
    PORT: TEST_PORT,
  })

  await waitForNeo4j(driver)
  await bootstrap(driver)

  const deps = {
    accounts: accountsRepo(driver),
    bills: billsRepo(driver),
    categories: categoriesRepo(driver),
    subCategories: subCategoriesRepo(driver),
    creditCards: creditCardsRepo(driver),
    merchants: merchantsRepo(driver),
    recurring: recurringRepo(driver),
    tags: tagsRepo(driver),
    transactions: transactionsRepo(driver),
    clock: () => new Date(),
    newId: () => randomUUID(),
  }

  app = Fastify()
  registerRoutes(app, deps)
  registerMcpRoute(app, deps)

  await app.listen({ port: TEST_PORT, host: '::' })
  process.env['MCP_URL'] = `http://127.0.0.1:${TEST_PORT}/mcp`
}

export const teardown = async () => {
  await app?.close()
  await container?.stop()
}
