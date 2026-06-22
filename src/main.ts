#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { loadConfig, McpTransport } from './config.js'
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
import { settingsRepo } from './diplomat/db/repos/settings.js'
import { tagsRepo } from './diplomat/db/repos/tags.js'
import { transactionsRepo } from './diplomat/db/repos/transactions.js'
import { connectStdio } from './diplomat/mcp/stdio.js'
import { Locale } from './models/locale.js'

const main = async (): Promise<void> => {
  const config = loadConfig()

  const db = openDatabase(config)
  await bootstrap(db)

  const settingsR = settingsRepo(db)

  let cachedLocale: Locale | null = null

  const resolveLocale = async (): Promise<Locale> => {
    if (config.FINTRACK_LOCALE) return config.FINTRACK_LOCALE
    if (cachedLocale) return cachedLocale
    const row = await settingsR.getLocale()
    cachedLocale = row?.locale ?? Locale.enum.en
    return cachedLocale
  }

  const resetLocale = (): void => { cachedLocale = null }

  const deps: Deps = {
    accounts: accountsRepo(db),
    bills: billsRepo(db),
    categories: categoriesRepo(db),
    subCategories: subCategoriesRepo(db),
    creditCards: creditCardsRepo(db),
    merchants: merchantsRepo(db),
    recurring: recurringRepo(db),
    settings: settingsR,
    tags: tagsRepo(db),
    transactions: transactionsRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    locale: resolveLocale,
    resetLocale,
  }

  if (config.MCP_TRANSPORT === McpTransport.enum.stdio) {
    const server = await connectStdio(deps)
    const shutdown = (): void => {
      server.close().catch((err: unknown) => console.error(err)).finally(() => process.exit(0))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    // stdin end/close = client disconnected; route through shutdown to drain in-flight work
    process.stdin.once('end', shutdown)
    process.stdin.once('close', shutdown)
    return
  }

  // MCP_TRANSPORT === 'http': start Fastify with REST + streamable HTTP MCP
  const { default: Fastify } = await import('fastify')
  const { registerRoutes } = await import('./diplomat/http/routes.js')
  const { registerMcpRoute } = await import('./diplomat/mcp/route.js')

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
  // eslint-disable-next-line no-console -- http-mode startup banner; stdout carries no MCP protocol in http mode (ADR-007)
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
        `Set a different port and retry, e.g. PORT=${port + 1} fintrack\n` +
        `Then point your MCP client at http://127.0.0.1:${port + 1}/mcp`,
    )
    process.exit(1)
  }
  console.error(e)
  process.exit(1)
})
