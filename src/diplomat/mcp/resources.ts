import { listAccounts } from '../../controllers/account/account.js';
import { listCategories } from '../../controllers/categories.js';
import { listCurrencies } from '../../controllers/currencies.js';
import { listExchangeRates } from '../../controllers/currency-rates.js';
import { topMerchants } from '../../controllers/merchants.js';
import { listCreditCards } from '../../controllers/credit-card/credit-card.js';
import { listTags } from '../../controllers/tags.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT } from '../../models/merchant.js';
import type { ResourceDefinition } from './definition.js';
import { jsonResource } from './respond.js';

const openapiDescription =
  'OpenAPI 3.0 document for the REST API (GET /api/openapi.json mirrors this). ' +
  'Read this before generating fetch() calls against /api endpoints (ADR-013).';

const openApiResource = (openApiDocument: unknown): ResourceDefinition => ({
  name: 'openapi',
  uri: 'fintrack://openapi',
  config: { title: 'FinTrack OpenAPI contract', description: openapiDescription, mimeType: 'application/json' },
  read: async (uri) => jsonResource(uri, openApiDocument),
});

const categoriesDescription =
  'Top-level categories with locale-resolved display names and kind (expense/income/both) — the same ' +
  'data list_categories returns. Read this to resolve a category name before classifying a transaction, ' +
  'without a tool round-trip.';

const categoriesResource: ResourceDefinition = {
  name: 'categories',
  uri: 'fintrack://categories',
  config: { title: 'Category taxonomy', description: categoriesDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listCategories(deps)),
};

const accountsDescription =
  'All accounts with name, type, and currency — the same data list_accounts returns. Read this to ' +
  'resolve an account name without a tool round-trip.';

const accountsResource: ResourceDefinition = {
  name: 'accounts',
  uri: 'fintrack://accounts',
  config: { title: 'Accounts', description: accountsDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listAccounts(deps)),
};

const currenciesDescription =
  'All currencies (fiat and crypto) with symbol and decimals — the same data GET /api/currencies returns. ' +
  "Read this to format an amount correctly: crypto codes (USDC, BTC) aren't ISO 4217, so a generic currency " +
  'formatter must use the symbol + decimals given here instead of assuming 2 decimal places.';

const currenciesResource: ResourceDefinition = {
  name: 'currencies',
  uri: 'fintrack://currencies',
  config: { title: 'Currencies', description: currenciesDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listCurrencies(deps)),
};

const exchangeRatesDescription =
  'All cached exchange rates, each with its own as_of — the same data list_exchange_rates returns. ' +
  'FinTrack never fetches rates itself (local-first, ADR-026); read this to see which pairs are ' +
  'cached and how fresh they are before deciding whether to refresh via set_exchange_rate(s).';

const exchangeRatesResource: ResourceDefinition = {
  name: 'exchange-rates',
  uri: 'fintrack://exchange-rates',
  config: { title: 'Exchange rates', description: exchangeRatesDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listExchangeRates(deps)),
};

const tagsResource: ResourceDefinition = {
  name: 'tags',
  uri: 'fintrack://tags',
  config: {
    title: 'Tags',
    description:
      'All tags — the same data list_tags returns. Read this to resolve a tag name without a tool round-trip.',
    mimeType: 'application/json',
  },
  read: async (uri, { deps }) => jsonResource(uri, await listTags(deps)),
};

const creditCardsDescription =
  'All credit cards — the same data list_credit_cards returns. Read this to resolve a card name without ' +
  'a tool round-trip.';

const creditCardsResource: ResourceDefinition = {
  name: 'credit-cards',
  uri: 'fintrack://credit-cards',
  config: { title: 'Credit cards', description: creditCardsDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listCreditCards(deps)),
};

const merchantsTopDescription =
  `The ${DEFAULT_TOP_MERCHANTS_LIMIT} merchants with the most effective, non-transfer transactions, each ` +
  'with the category it is most often classified into — the vocabulary of merchants the user actually ' +
  'deals with (e.g. "iFood → Alimentação"), by transaction frequency (not spend). Not a money report: no ' +
  'per-currency amounts. categoryName is null for a merchant whose transactions are all uncategorized.';

const merchantsTopResource: ResourceDefinition = {
  name: 'merchants-top',
  uri: 'fintrack://merchants/top',
  config: { title: 'Top merchants', description: merchantsTopDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await topMerchants(deps)),
};

/** The reference resources (Feature Design 018) plus the OpenAPI document — few and cross-domain, so one module rather
 *  than one per domain (ADR-025). The OpenAPI document is the one definition that needs context: it is built once. */
export const resourceDefinitions = (openApiDocument: unknown): ResourceDefinition[] => [
  openApiResource(openApiDocument),
  categoriesResource,
  accountsResource,
  currenciesResource,
  exchangeRatesResource,
  tagsResource,
  creditCardsResource,
  merchantsTopResource,
];
