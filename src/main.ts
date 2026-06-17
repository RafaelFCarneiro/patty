#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { loadConfig } from './config.js'
import type { Deps } from './controllers/deps.js'
import { bootstrap } from './diplomat/db/bootstrap.js'
import { openDatabase } from './diplomat/db/driver.js'
import { accountsRepo } from './diplomat/db/repos/accounts.js'
import { billsRepo } from './diplomat/db/repos/bills.js'
import { categoriesRepo } from './diplomat/db/repos/categories.js'
import { subCategoriesRepo } from './diplomat/db/repos/subCategories.js'
import { creditCardsRepo } from './diplomat/db/repos/creditCards.js'
import { merchantsRepo } from './diplomat/db/repos/merchants.js'
import { recurringRepo } from './diplomat/db/repos/recurring.js'
import { tagsRepo } from './diplomat/db/repos/tags.js'
import { transactionsRepo } from './diplomat/db/repos/transactions.js'
import { registerRoutes } from './diplomat/http/routes.js'
import { registerMcpRoute } from './diplomat/mcp/route.js'

const main = async (): Promise<void> => {
  const config = loadConfig()

  const db = openDatabase(config)
  await bootstrap(db)

  const deps: Deps = {
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

  const app = Fastify({ logger: true })
  registerRoutes(app, deps)
  registerMcpRoute(app, deps)

  const shutdown = (): void => {
    app.close()
      .catch((err: unknown) => app.log.error(err))
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // '::' binds dual-stack (IPv6 + IPv4) so both localhost (::1) and 127.0.0.1 work
  await app.listen({ port: config.PORT, host: '::' })
  console.log(`fintrack: REST http://localhost:${config.PORT}/api · MCP http://localhost:${config.PORT}/mcp`)
}

const isPortInUse = (e: unknown): e is { code: string; port: number } =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === 'EADDRINUSE' &&
  typeof (e as { port?: unknown }).port === 'number'

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    const port = e.port
    console.error(
      `fintrack: port ${port} is already in use (another service or MCP server is on it).\n` +
        `Set a different port and retry, e.g.  PORT=${port + 1} fintrack\n` +
        `Then point your MCP client at http://127.0.0.1:${port + 1}/mcp`,
    )
    process.exit(1)
  }
  console.error(e)
  process.exit(1)
})
