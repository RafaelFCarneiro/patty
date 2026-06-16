import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, inject } from 'vitest'
import { bootstrap } from '../../src/diplomat/db/bootstrap.js'
import { openDatabase } from '../../src/diplomat/db/driver.js'
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
// Fixed 64-char hex key for integration tests — never touches the OS keychain.
const TEST_ENCRYPTION_KEY = 'a'.repeat(64)

// Set before test modules are evaluated so helpers.ts picks it up at import time.
process.env['MCP_URL'] = `http://127.0.0.1:${TEST_PORT}/mcp`

let app: FastifyInstance

beforeAll(async () => {
  const db = openDatabase({
    DB_PATH: inject('DB_PATH') as string,
    FINTRACK_DB_KEY: TEST_ENCRYPTION_KEY,
    PORT: TEST_PORT,
  })

  await bootstrap(db)

  const deps = {
    accounts: accountsRepo(db),
    bills: billsRepo(db),
    categories: categoriesRepo(db),
    subCategories: subCategoriesRepo(db),
    creditCards: creditCardsRepo(db),
    merchants: merchantsRepo(db),
    recurring: recurringRepo(db),
    tags: tagsRepo(db),
    transactions: transactionsRepo(db),
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
