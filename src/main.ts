import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { loadConfig } from './config.js'
import type { Deps } from './controllers/deps.js'
import { bootstrap } from './diplomat/db/bootstrap.js'
import { createDriver, waitForNeo4j } from './diplomat/db/driver.js'
import { accountsRepo } from './diplomat/db/repos/accounts.js'
import { billsRepo } from './diplomat/db/repos/bills.js'
import { categoriesRepo } from './diplomat/db/repos/categories.js'
import { creditCardsRepo } from './diplomat/db/repos/creditCards.js'
import { merchantsRepo } from './diplomat/db/repos/merchants.js'
import { recurringRepo } from './diplomat/db/repos/recurring.js'
import { transactionsRepo } from './diplomat/db/repos/transactions.js'
import { transfersRepo } from './diplomat/db/repos/transfers.js'
import { registerRoutes } from './diplomat/http/routes.js'
import { registerMcpRoute } from './diplomat/mcp/route.js'

const main = async (): Promise<void> => {
  const config = loadConfig()

  const driver = createDriver(config)
  await waitForNeo4j(driver)
  await bootstrap(driver)
  console.log('neo4j ready: constraints + seed applied')

  const deps: Deps = {
    accounts: accountsRepo(driver),
    bills: billsRepo(driver),
    categories: categoriesRepo(driver),
    creditCards: creditCardsRepo(driver),
    merchants: merchantsRepo(driver),
    recurring: recurringRepo(driver),
    transactions: transactionsRepo(driver),
    transfers: transfersRepo(driver),
    clock: () => new Date(),
    newId: () => randomUUID(),
  }

  const app = Fastify({ logger: true })
  registerRoutes(app, deps)
  registerMcpRoute(app, deps)

  const close = async () => {
    await app.close()
    await driver.close()
    process.exit(0)
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)

  // '::' binds dual-stack (IPv6 + IPv4) so both localhost (::1) and 127.0.0.1 work
  await app.listen({ port: config.PORT, host: '::' })
  console.log(`fintrack: REST http://localhost:${config.PORT}/api · MCP http://localhost:${config.PORT}/mcp`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
