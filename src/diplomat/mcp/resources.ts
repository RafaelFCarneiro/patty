import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAccounts } from '../../controllers/account/account.js';
import { listCategories } from '../../controllers/categories.js';
import { listCurrencies } from '../../controllers/currencies.js';
import { listExchangeRates } from '../../controllers/currencyRates.js';
import { topMerchants } from '../../controllers/merchants.js';
import { listCreditCards } from '../../controllers/creditCard/creditCard.js';
import { listTags } from '../../controllers/tags.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT } from '../../models/merchant.js';
import type { McpContext } from './context.js';
import { jsonResource } from './respond.js';

/** The reference resources (Feature Design 018) plus the OpenAPI document — few and cross-domain,
 *  so they live in one module rather than one per domain (ADR-025). */
export const registerResources = (server: McpServer, ctx: McpContext, openApiDocument: unknown): void => {
  const { deps } = ctx;

  server.registerResource(
    'openapi',
    'fintrack://openapi',
    {
      title: 'FinTrack OpenAPI contract',
      description:
        'OpenAPI 3.0 document for the REST API (GET /api/openapi.json mirrors this). ' +
        'Read this before generating fetch() calls against /api endpoints (ADR-013).',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, openApiDocument),
  );

  server.registerResource(
    'categories',
    'fintrack://categories',
    {
      title: 'Category taxonomy',
      description:
        'Top-level categories with locale-resolved display names and kind (expense/income/both) — the same ' +
        'data list_categories returns. Read this to resolve a category name before classifying a transaction, ' +
        'without a tool round-trip.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await listCategories(deps)),
  );

  server.registerResource(
    'accounts',
    'fintrack://accounts',
    {
      title: 'Accounts',
      description:
        'All accounts with name, type, and currency — the same data list_accounts returns. Read this to ' +
        'resolve an account name without a tool round-trip.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await listAccounts(deps)),
  );

  server.registerResource(
    'currencies',
    'fintrack://currencies',
    {
      title: 'Currencies',
      description:
        'All currencies (fiat and crypto) with symbol and decimals — the same data GET /api/currencies returns. ' +
        "Read this to format an amount correctly: crypto codes (USDC, BTC) aren't ISO 4217, so a generic currency " +
        'formatter must use the symbol + decimals given here instead of assuming 2 decimal places.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await listCurrencies(deps)),
  );

  server.registerResource(
    'exchange-rates',
    'fintrack://exchange-rates',
    {
      title: 'Exchange rates',
      description:
        'All cached exchange rates, each with its own as_of — the same data list_exchange_rates returns. ' +
        'FinTrack never fetches rates itself (local-first, ADR-026); read this to see which pairs are ' +
        'cached and how fresh they are before deciding whether to refresh via set_exchange_rate(s).',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await listExchangeRates(deps)),
  );

  server.registerResource(
    'tags',
    'fintrack://tags',
    {
      title: 'Tags',
      description:
        'All tags — the same data list_tags returns. Read this to resolve a tag name without a tool round-trip.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await listTags(deps)),
  );

  server.registerResource(
    'credit-cards',
    'fintrack://credit-cards',
    {
      title: 'Credit cards',
      description:
        'All credit cards — the same data list_credit_cards returns. Read this to resolve a card name without ' +
        'a tool round-trip.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await listCreditCards(deps)),
  );

  server.registerResource(
    'merchants-top',
    'fintrack://merchants/top',
    {
      title: 'Top merchants',
      description:
        `The ${DEFAULT_TOP_MERCHANTS_LIMIT} merchants with the most effective, non-transfer transactions, each ` +
        'with the category it is most often classified into — the vocabulary of merchants the user actually ' +
        'deals with (e.g. "iFood → Alimentação"), by transaction frequency (not spend). Not a money report: no ' +
        'per-currency amounts. categoryName is null for a merchant whose transactions are all uncategorized.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri, await topMerchants(deps)),
  );
};
