#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { isPortInUse, LOOPBACK_HOST, portInUseReason } from './common/net.js';
import { loadConfig, McpTransport, type Config } from './config.js';
import type { Deps, UnitOfWork } from './controllers/deps.js';
import { bootstrap } from './diplomat/db/bootstrap.js';
import { openDatabase } from './diplomat/db/driver.js';
import { withUnitOfWork, type ApplierRegistry } from './diplomat/db/unitOfWork.js';
import { accountApplier, accountsRepo } from './diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from './diplomat/db/repos/bills.js';
import { categoriesRepo, categoryApplier } from './diplomat/db/repos/categories.js';
import { subCategoriesRepo } from './diplomat/db/repos/subCategories.js';
import { creditCardApplier, creditCardsRepo } from './diplomat/db/repos/creditCards.js';
import { dashboardsRepo } from './diplomat/db/repos/dashboards.js';
import { merchantCategoryApplier, merchantsRepo } from './diplomat/db/repos/merchants.js';
import { recurringRepo } from './diplomat/db/repos/recurring.js';
import { settingsRepo } from './diplomat/db/repos/settings.js';
import { tagApplier, tagsRepo } from './diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from './diplomat/db/repos/transactions.js';
import { healthRepo } from './diplomat/db/repos/health.js';
import { connectStdio } from './diplomat/mcp/stdio.js';
import { Locale } from './models/locale.js';
import { ACCOUNT_ENTITY_TAG } from './models/account.js';
import { BILL_ENTITY_TAG } from './models/bill.js';
import { CATEGORY_ENTITY_TAG } from './models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from './models/creditCard.js';
import { MERCHANT_CATEGORY_ENTITY_TAG } from './models/merchant.js';
import { TAG_ENTITY_TAG } from './models/tag.js';
import { TRANSACTION_ENTITY_TAG } from './models/transaction.js';
import type { HttpSidecar } from './server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/**
 * Lazily imports the HTTP composition module (server.ts) so Fastify — and the whole REST /
 * MCP-over-HTTP route table it wires up — is never loaded during the default stdio-only
 * startup path, only when the sidecar is enabled or MCP_TRANSPORT=http actually needs it
 * (ADR-007). Isolated here as one named function instead of an inline import() at each call site.
 */
const loadServerModule = () => import('./server.js');

const maybeStartSidecar = async (
  deps: Deps,
  version: string,
  unitOfWork: UnitOfWork,
  config: Config,
): Promise<HttpSidecar | null> => {
  if (!config.FINTRACK_HTTP) return null;
  const { startHttpSidecar } = await loadServerModule();
  return startHttpSidecar(deps, version, unitOfWork, config.PORT);
};

const main = async (): Promise<void> => {
  if (process.argv[2] === 'setup') {
    const { runSetup } = await import('./setup.js');
    runSetup(process.argv[3]);
    return;
  }

  const config = loadConfig();

  const db = openDatabase(config);
  await bootstrap(db);

  const settingsR = settingsRepo(db);

  let cachedLocale: Locale | null = null;

  const resolveLocale = async (): Promise<Locale> => {
    if (config.FINTRACK_LOCALE) return config.FINTRACK_LOCALE;
    if (cachedLocale) return cachedLocale;
    const row = await settingsR.getLocale();
    cachedLocale = row?.locale ?? Locale.enum.en;
    return cachedLocale;
  };

  const resetLocale = (): void => {
    cachedLocale = null;
  };

  const deps: Deps = {
    accounts: accountsRepo(db),
    bills: billsRepo(db),
    categories: categoriesRepo(db),
    subCategories: subCategoriesRepo(db),
    creditCards: creditCardsRepo(db),
    dashboards: dashboardsRepo(db),
    health: healthRepo(db),
    merchants: merchantsRepo(db),
    recurring: recurringRepo(db),
    settings: settingsR,
    tags: tagsRepo(db),
    transactions: transactionsRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    locale: resolveLocale,
    resetLocale,
  };

  // Every converted entity's applier, keyed by its own tag (ADR-021) — assembled once here, the
  // composition root, so `diplomat/db/unitOfWork.ts` itself never names a specific entity.
  const applierRegistry: ApplierRegistry = {
    [ACCOUNT_ENTITY_TAG]: accountApplier,
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier,
    [BILL_ENTITY_TAG]: billApplier,
    [TAG_ENTITY_TAG]: tagApplier,
    [CATEGORY_ENTITY_TAG]: categoryApplier,
    [CREDIT_CARD_ENTITY_TAG]: creditCardApplier,
  };
  const runUnitOfWork: UnitOfWork = (flow) => withUnitOfWork(db, applierRegistry, flow);

  if (config.MCP_TRANSPORT === McpTransport.enum.stdio) {
    const server = await connectStdio(deps, version, runUnitOfWork);

    // A bind failure inside startHttpSidecar is caught there and is never fatal — the stdio
    // connection above is the resilient primary (ADR-013 Decision 7).
    const sidecar = await maybeStartSidecar(deps, version, runUnitOfWork, config);

    // 'close' commonly follows 'end' on stdin, and a client can also send SIGINT/SIGTERM around
    // the same disconnect — guard against shutdown() running (and double process.exit-ing) twice.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void Promise.allSettled([
        server.close().catch((err: unknown) => console.error(err)),
        sidecar?.listening ? sidecar.app.close().catch((err: unknown) => console.error(err)) : Promise.resolve(),
      ]).finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // stdin end/close = client disconnected; route through shutdown to drain in-flight work
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    return;
  }

  // MCP_TRANSPORT === 'http': start Fastify with REST + streamable HTTP MCP. Unlike the
  // sidecar, this is the only surface running — a bind failure here is fatal by design
  // (there is no stdio fallback to keep the process alive), handled below in main().catch.
  const { buildHttpApp } = await loadServerModule();
  const app = buildHttpApp(deps, version, runUnitOfWork);

  // A repeated signal (or SIGINT followed by SIGTERM) must not double-close/double-exit.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app
      .close()
      .catch((err: unknown) => app.log.error(err))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.PORT, host: LOOPBACK_HOST });
  // config.PORT may be 0 (OS-assigned); read back the address actually bound for the banner.
  const boundPort = (app.server.address() as AddressInfo).port;
  // eslint-disable-next-line no-console -- HTTP-mode banner; stdout safe (ADR-007 restricts stdio only)
  console.log(
    `fintrack: REST http://${LOOPBACK_HOST}:${boundPort}/api` + ` · MCP http://${LOOPBACK_HOST}:${boundPort}/mcp`,
  );
};

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    const port = e.port;
    console.error(
      `fintrack: ${portInUseReason(port)}.\n` +
        `Set a different port and retry, e.g. PORT=${port + 1} fintrack\n` +
        `Then point your MCP client at http://${LOOPBACK_HOST}:${port + 1}/mcp`,
    );
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
