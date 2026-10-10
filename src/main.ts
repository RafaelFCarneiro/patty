#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { AUTH_APPLIERS, prepareAuth } from './authRuntime.js';
import { CliCommand } from './common/cli.js';
import { httpOrigin, isPortInUse, portInUseMessage } from './common/net.js';
import { loadConfig, McpTransport, type Config } from './config.js';
import type { Deps, RunEffects, RunEffectsSequence } from './controllers/deps.js';
import { bootstrap } from './diplomat/db/bootstrap.js';
import { openDatabase } from './diplomat/db/driver.js';
import { createEngineContext } from './diplomat/db/engine.js';
import type { ApplierRegistry } from './diplomat/db/effects.js';
import { createChangeBus, runEffects, runEffectsSequence, type ChangeBus } from '@rfc0/effect-runner';
import { createLocaleResolver } from './diplomat/db/localeCache.js';
import { accountApplier, accountsRepo } from './diplomat/db/repos/accounts.js';
import { billApplier, billsRepo } from './diplomat/db/repos/bills.js';
import { budgetApplier, budgetsRepo } from './diplomat/db/repos/budgets.js';
import { categoriesRepo, categoryApplier } from './diplomat/db/repos/categories.js';
import { subCategoriesRepo } from './diplomat/db/repos/subCategories.js';
import { correlationsRepo } from './diplomat/db/repos/correlations.js';
import { creditCardApplier, creditCardsRepo } from './diplomat/db/repos/creditCards.js';
import { currenciesRepo } from './diplomat/db/repos/currencies.js';
import { currencyRateApplier, currencyRatesRepo } from './diplomat/db/repos/currencyRates.js';
import { dashboardApplier, dashboardsRepo } from './diplomat/db/repos/dashboards.js';
import { merchantApplier, merchantCategoryApplier, merchantsRepo } from './diplomat/db/repos/merchants.js';
import { recurringRepo, recurringRuleApplier } from './diplomat/db/repos/recurring.js';
import { settingsApplier, settingsRepo } from './diplomat/db/repos/settings.js';
import { tagApplier, tagsRepo } from './diplomat/db/repos/tags.js';
import { transactionApplier, transactionsRepo } from './diplomat/db/repos/transactions.js';
import { transactionTagApplier } from './diplomat/db/repos/transactionTags.js';
import { healthRepo } from './diplomat/db/repos/health.js';
import type { HttpAuth } from './diplomat/http/context.js';
import { connectStdio } from './diplomat/mcp/stdio.js';
import { ACCOUNT_ENTITY_TAG } from './models/account.js';
import { BILL_ENTITY_TAG } from './models/bill.js';
import { BUDGET_ENTITY_TAG } from './models/budget.js';
import { CATEGORY_ENTITY_TAG } from './models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from './models/creditCard.js';
import { CURRENCY_RATE_ENTITY_TAG } from './models/currencyRate.js';
import { DASHBOARD_ENTITY_TAG } from './models/dashboard.js';
import { SETTINGS_ENTITY_TAG } from './models/locale.js';
import { MERCHANT_CATEGORY_ENTITY_TAG, MERCHANT_ENTITY_TAG } from './models/merchant.js';
import { RECURRING_ENTITY_TAG } from './models/recurring.js';
import { TAG_ENTITY_TAG } from './models/tag.js';
import { TRANSACTION_ENTITY_TAG } from './models/transaction.js';
import { TRANSACTION_TAG_ENTITY_TAG } from './models/transactionTag.js';
import type { HttpSidecar } from './server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/**
 * Lazily imports the HTTP composition module (server.ts) so Fastify — and the whole REST /
 * MCP-over-HTTP route table it wires up — is never loaded during the default stdio-only
 * startup path, only when the sidecar is enabled or MCP_TRANSPORT=http actually needs it.
 * Isolated here as one named function instead of an inline import() at each call site.
 */
const loadServerModule = () => import('./server.js');

/** The command mode (`setup`, `auth …`) loads only when one of those is asked for — never on a server start. */
const loadCliModule = () => import('./cli.js');

// stderr only — stdout carries the MCP protocol on the stdio transport (ADR-007).
const reportChangeError = (cause: unknown): void => {
  console.error('[fintrack] change notification failed:', cause);
};

const maybeStartSidecar = async (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  subscribeToChanges: ChangeBus['subscribe'],
  config: Config,
  auth: HttpAuth,
): Promise<HttpSidecar | null> => {
  if (!config.FINTRACK_HTTP) return null;
  const { startHttpSidecar } = await loadServerModule();
  return startHttpSidecar(
    deps,
    version,
    runEffects,
    runEffectsSequence,
    resetLocale,
    subscribeToChanges,
    config.PORT,
    config.HOST,
    { auth, trustProxy: config.TRUST_PROXY },
  );
};

const main = async (): Promise<void> => {
  if (CliCommand.safeParse(process.argv[2]).success) {
    const { runCli } = await loadCliModule();
    // Not process.exit: let the event loop drain, so everything the command printed has been flushed.
    process.exitCode = await runCli(process.argv.slice(2));
    return;
  }

  const config = loadConfig();

  const db = await openDatabase(config);
  await bootstrap(db);

  const settingsR = settingsRepo(db);
  const localeResolver = createLocaleResolver(settingsR, config.FINTRACK_LOCALE);

  const deps: Deps = {
    accounts: accountsRepo(db),
    bills: billsRepo(db),
    budgets: budgetsRepo(db),
    categories: categoriesRepo(db),
    subCategories: subCategoriesRepo(db),
    correlations: correlationsRepo(db),
    creditCards: creditCardsRepo(db),
    currencies: currenciesRepo(db),
    currencyRates: currencyRatesRepo(db),
    dashboards: dashboardsRepo(db),
    health: healthRepo(db),
    merchants: merchantsRepo(db),
    recurring: recurringRepo(db),
    settings: settingsR,
    tags: tagsRepo(db),
    transactions: transactionsRepo(db),
    clock: () => new Date(),
    newId: () => randomUUID(),
    locale: localeResolver.locale,
    rateStaleness: { fiatHours: config.FIAT_RATE_STALE_HOURS, cryptoHours: config.CRYPTO_RATE_STALE_HOURS },
  };

  const applierRegistry: ApplierRegistry = {
    [ACCOUNT_ENTITY_TAG]: accountApplier,
    [TRANSACTION_ENTITY_TAG]: transactionApplier,
    [TRANSACTION_TAG_ENTITY_TAG]: transactionTagApplier,
    [MERCHANT_ENTITY_TAG]: merchantApplier,
    [MERCHANT_CATEGORY_ENTITY_TAG]: merchantCategoryApplier,
    [BILL_ENTITY_TAG]: billApplier,
    [BUDGET_ENTITY_TAG]: budgetApplier,
    [TAG_ENTITY_TAG]: tagApplier,
    [CATEGORY_ENTITY_TAG]: categoryApplier,
    [CREDIT_CARD_ENTITY_TAG]: creditCardApplier,
    [CURRENCY_RATE_ENTITY_TAG]: currencyRateApplier,
    [RECURRING_ENTITY_TAG]: recurringRuleApplier,
    [DASHBOARD_ENTITY_TAG]: dashboardApplier,
    [SETTINGS_ENTITY_TAG]: settingsApplier,
    ...AUTH_APPLIERS,
  };

  const changeBus = createChangeBus({ onError: reportChangeError });
  const engineContext = createEngineContext(db, reportChangeError);
  const boundRunEffects: RunEffects = (flow) => runEffects(engineContext, applierRegistry, flow, changeBus.publish);
  const boundRunEffectsSequence: RunEffectsSequence = (items, flowFor) =>
    runEffectsSequence(engineContext, applierRegistry, items, flowFor, changeBus.publish);

  // Sessions guard the HTTP surface only: stdio is spawned by the user and still acts as the owner (ADR-034 step 2
  // changes that).
  const { auth, issueAndAnnounceSetup } = await prepareAuth(config, db, boundRunEffects);

  if (config.MCP_TRANSPORT === McpTransport.enum.stdio) {
    const server = await connectStdio(
      deps,
      version,
      boundRunEffects,
      boundRunEffectsSequence,
      localeResolver.resetLocale,
    );

    // A bind failure inside startHttpSidecar is caught there and is never fatal — the stdio
    const sidecar = await maybeStartSidecar(
      deps,
      version,
      boundRunEffects,
      boundRunEffectsSequence,
      localeResolver.resetLocale,
      changeBus.subscribe,
      config,
      auth,
    );
    // The setup code is issued and printed only now, naming the origin the sidecar really bound. If it did not
    // bind (another process owns the port and has announced its own code) this process must not replace that
    // code with one nobody sees.
    if (sidecar?.listening) {
      await issueAndAnnounceSetup(httpOrigin(config.HOST, (sidecar.app.server.address() as AddressInfo).port));
    }

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
  const app = buildHttpApp(
    deps,
    version,
    boundRunEffects,
    boundRunEffectsSequence,
    localeResolver.resetLocale,
    changeBus.subscribe,
    { auth, trustProxy: config.TRUST_PROXY },
  );

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

  await app.listen({ port: config.PORT, host: config.HOST });
  // config.PORT may be 0 (OS-assigned); read back the address actually bound for the banner.
  const boundPort = (app.server.address() as AddressInfo).port;
  const origin = httpOrigin(config.HOST, boundPort);
  // eslint-disable-next-line no-console -- HTTP-mode banner; stdout safe.
  console.log(`fintrack: REST ${origin}/api · MCP ${origin}/mcp`);
  await issueAndAnnounceSetup(origin);
};

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    console.error(portInUseMessage(e));
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
