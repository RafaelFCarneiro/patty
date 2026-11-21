import { listAccounts } from '../../controllers/account/account.js';
import { listAssets } from '../../controllers/investment/assets.js';
import { listCategories } from '../../controllers/categories.js';
import { listCurrencies } from '../../controllers/currencies.js';
import { listExchangeRates } from '../../controllers/currency-rates.js';
import { topMerchants } from '../../controllers/merchants.js';
import { listCreditCards } from '../../controllers/credit-card/credit-card.js';
import { listTags } from '../../controllers/tags.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT } from '../../models/merchant.js';
import type { ResourceDefinition } from './definition.js';
import { jsonResource } from './respond.js';
import { ToolName } from './tool-name.js';
import { PRODUCT_NAME } from '../../models/package.js';

/** The one spelling of each resource URI: the definitions and `tool-paths.ts` both name them. */
export const ResourceUri = {
  openapi: 'patty://openapi',
  categories: 'patty://categories',
  accounts: 'patty://accounts',
  currencies: 'patty://currencies',
  exchangeRates: 'patty://exchange-rates',
  assets: 'patty://assets',
  tags: 'patty://tags',
  creditCards: 'patty://credit-cards',
  merchantsTop: 'patty://merchants/top',
} as const;

const openapiDescription =
  'OpenAPI 3.0 document for the REST API (GET /api/openapi.json mirrors this; tool-only clients use the ' +
  `${ToolName.enum.get_api_contract} tool). ` +
  'Read this before generating fetch() calls against /api endpoints (ADR-013).';

const openApiResource = (openApiDocument: unknown): ResourceDefinition => ({
  name: 'openapi',
  uri: ResourceUri.openapi,
  config: { title: `${PRODUCT_NAME} OpenAPI contract`, description: openapiDescription, mimeType: 'application/json' },
  read: async (uri) => jsonResource(uri, openApiDocument),
});

const categoriesDescription =
  'Top-level categories with locale-resolved display names and kind (expense/income/both) — the same ' +
  'data list_categories returns. Read this to resolve a category name before classifying a transaction, ' +
  'without a tool round-trip.';

const categoriesResource: ResourceDefinition = {
  name: 'categories',
  uri: ResourceUri.categories,
  config: { title: 'Category taxonomy', description: categoriesDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listCategories(deps)),
};

const accountsDescription =
  'All accounts with name, type, and currency — the same data list_accounts returns. Read this to ' +
  'resolve an account name without a tool round-trip.';

const accountsResource: ResourceDefinition = {
  name: 'accounts',
  uri: ResourceUri.accounts,
  config: { title: 'Accounts', description: accountsDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listAccounts(deps)),
};

export const currenciesDescription =
  `All currencies (fiat and crypto) with symbol and decimals — the same data as ${ToolName.enum.list_currencies}, ` +
  'patty://currencies and GET /api/currencies. Format an amount with the symbol and decimals given here: crypto ' +
  "codes (USDC, BTC) aren't ISO 4217, so a generic currency formatter must not assume 2 decimal places.";

const currenciesResource: ResourceDefinition = {
  name: 'currencies',
  uri: ResourceUri.currencies,
  config: { title: 'Currencies', description: currenciesDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listCurrencies(deps)),
};

const exchangeRatesDescription =
  'All cached exchange rates, each with its own as_of — the same data list_exchange_rates returns. ' +
  `${PRODUCT_NAME} never fetches rates itself (local-first, ADR-026); read this to see which pairs are ` +
  'cached and how fresh they are before deciding whether to refresh via set_exchange_rate(s).';

const exchangeRatesResource: ResourceDefinition = {
  name: 'exchange-rates',
  uri: ResourceUri.exchangeRates,
  config: { title: 'Exchange rates', description: exchangeRatesDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listExchangeRates(deps)),
};

const assetsDescription =
  'All registered assets (stocks, ETFs, REITs, BDRs, fixed income) with their latest price, as_of and staleness — ' +
  `the same data list_assets returns. ${PRODUCT_NAME} never fetches prices itself (Feature Design 023); read this to see ` +
  'which are missing or stale before refreshing them with set_asset_prices.';

const assetsResource: ResourceDefinition = {
  name: 'assets',
  uri: ResourceUri.assets,
  config: { title: 'Assets', description: assetsDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listAssets(deps, {})),
};

const tagsResource: ResourceDefinition = {
  name: 'tags',
  uri: ResourceUri.tags,
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
  uri: ResourceUri.creditCards,
  config: { title: 'Credit cards', description: creditCardsDescription, mimeType: 'application/json' },
  read: async (uri, { deps }) => jsonResource(uri, await listCreditCards(deps)),
};

export const merchantsTopDescription =
  `The ${DEFAULT_TOP_MERCHANTS_LIMIT} merchants with the most effective, non-transfer transactions, each ` +
  'with the category it is most often classified into — the vocabulary of merchants the user actually ' +
  'deals with (e.g. "iFood → Alimentação"), by transaction frequency (not spend). Not a money report: no ' +
  'per-currency amounts. categoryName is null for a merchant whose transactions are all uncategorized.';

const merchantsTopResource: ResourceDefinition = {
  name: 'merchants-top',
  uri: ResourceUri.merchantsTop,
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
  assetsResource,
  tagsResource,
  creditCardsResource,
  merchantsTopResource,
];
