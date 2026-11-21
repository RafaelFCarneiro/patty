import { ResourceUri } from './resources.js';
import { ToolName } from './tool-name.js';

const T = ToolName.enum;

/**
 * Tools are the one surface every client gets: anything offered as a prompt, resource or skill is also reachable
 * through a tool This is where each prompt and resource names its tool; a unit test walks
 * the registered definitions and fails for one without an entry here, or whose tool is not registered.
 */

/** Every prompt is run through `get_workflow` with its own name. */
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
