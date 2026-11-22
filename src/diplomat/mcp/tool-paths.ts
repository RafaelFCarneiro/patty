import { ResourceUri } from './resources.js';
import { ToolName } from './tool-name.js';

const T = ToolName.enum;

export const PROMPT_TOOL_PATH = T.get_workflow;

export const RESOURCE_TOOL_PATHS = {
  [ResourceUri.openapi]: T.get_api_contract,
  [ResourceUri.categories]: T.list_categories,
  [ResourceUri.accounts]: T.list_accounts,
  [ResourceUri.currencies]: T.list_currencies,
  [ResourceUri.exchangeRates]: T.list_exchange_rates,
  [ResourceUri.assets]: T.list_assets,
  [ResourceUri.tags]: T.list_tags,
  [ResourceUri.creditCards]: T.list_credit_cards,
  [ResourceUri.merchantsTop]: T.list_top_merchants,
} as const satisfies Record<(typeof ResourceUri)[keyof typeof ResourceUri], ToolName>;
