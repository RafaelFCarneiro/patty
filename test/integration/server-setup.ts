import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, inject } from 'vitest'
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

// Set before test modules are evaluated so helpers.ts picks it up at import time
process.env['MCP_URL'] = `http://127.0.0.1:${TEST_PORT}/mcp`

let app: FastifyInstance

beforeAll(async () => {
  const driver = createDriver({
    NEO4J_URI: inject('NEO4J_URI') as string,
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: inject('NEO4J_PASSWORD') as string,
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
})

afterAll(async () => {
  await app?.close()
})
