import { ToolName } from '../tool-name.js';
import * as accountAdapters from '../../../adapters/accounts.js';
import * as assetAdapters from '../../../adapters/assets.js';
import * as investmentAdapters from '../../../adapters/investment-events.js';
import { listAssets, registerAsset, setAssetPrice } from '../../../controllers/investment/assets.js';
import {
  deleteInvestmentEvent,
  listInvestmentEvents,
  openPosition,
  updateInvestmentEvent,
} from '../../../controllers/investment/events.js';
import { getPortfolio } from '../../../controllers/investment/portfolio.js';
import { buildBulkResult } from '../../../logic/asset.js';
import {
  DEFAULT_MANUAL_PRICE_STALE_DAYS,
  DEFAULT_PRICE_STALE_HOURS,
  ListAssetsSchema,
  RegisterAssetSchema,
} from '../../../models/asset.js';
import {
  DeleteInvestmentEventSchema,
  GetPortfolioSchema,
  ListInvestmentEventsSchema,
  OpenPositionSchema,
  UpdateInvestmentEventSchema,
} from '../../../models/investment.js';
import { SetAssetPricesSchema } from '../../../wire/in/assets.js';
import { PRODUCT_NAME } from '../../../models/package.js';
import { defineTool } from '../definition.js';
import { MUTATING, READ_ONLY } from '../annotations.js';
import { fromResult, json } from '../respond.js';

const T = ToolName.enum;

const PRICE_SOURCING_NOTE =
  `${PRODUCT_NAME} never fetches prices itself (local-first, zero external calls — ADR-026, ADR-038). ` +
  'The AI agent sources current quotes (or asks the user for a manually valued asset) and posts them with ' +
  `${T.set_asset_prices}; a price change is never a transaction, so cash-flow reports are untouched. `;

const registerAssetTool = defineTool({
  name: T.register_asset,
  config: {
    annotations: MUTATING,
    title: 'Register asset',
    description:
      'Register something with a price: a stock, ETF, REIT (FII), BDR or fixed-income product, by symbol and ' +
      'exchange (e.g. NU on NYSE, KNCR11 on B3). `currency` is the quote currency; `pricing` is "market" (a public ' +
      'quote exists) or "manual" (the agent posts the value, e.g. a CDB). Idempotent on symbol + exchange: an ' +
      'asset already registered is returned unchanged (a new name only renames it) with a warning for any other ' +
      'field that differs. Assets are shared by every user of the instance. BTC and USDC are currencies, not ' +
      `assets: keep those as accounts in that currency. ${PRICE_SOURCING_NOTE}`,
    inputSchema: RegisterAssetSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => registerAsset(deps, args).map(assetAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listAssetsTool = defineTool({
  name: T.list_assets,
  config: {
    annotations: READ_ONLY,
    title: 'List assets',
    description:
      'Registered assets with their latest price, `priceAsOf`, `stale` and `noPrice`. Staleness is per pricing ' +
      `class: market quotes after PRICE_STALE_HOURS (default ${DEFAULT_PRICE_STALE_HOURS} h, so a Friday close is ` +
      `still fresh on Monday), manual values after MANUAL_PRICE_STALE_DAYS (default ${DEFAULT_MANUAL_PRICE_STALE_DAYS}). ` +
      'Filter by `assetClass`, or pass `staleOnly` for the ' +
      `assets that need a fresh price. ${PRICE_SOURCING_NOTE}`,
    inputSchema: ListAssetsSchema.shape,
  },
  handle: async (args, { deps }) => json(await listAssets(deps, args)),
});

const setAssetPricesTool = defineTool({
  name: T.set_asset_prices,
  config: {
    annotations: MUTATING,
    title: 'Set asset prices (bulk)',
    description:
      'Post the price of ONE unit of each asset, in the asset currency, as of an ISO 8601 `asOf`. `asset` is a ' +
      'symbol, or EXCHANGE:SYMBOL when one symbol is quoted on two exchanges. Prices are kept as history (the ' +
      'newest `asOf` is the current one); a price for an instant already on file is revised. Partial success: an ' +
      "unknown asset fails only its own item — check each item's status. " +
      PRICE_SOURCING_NOTE,
    inputSchema: SetAssetPricesSchema.shape,
  },
  // Orchestration (run each item → bulk result) that belongs in a controller; kept as one named step here.
  handle: async (args, { deps, runEffectsSequence }) => {
    const outcomes = await runEffectsSequence(
      args.prices,
      (item) => () => setAssetPrice(deps, item).map(assetAdapters.priceOutcomeToDb),
    );
    return json(assetAdapters.bulkResultToWireOut(buildBulkResult(args.prices, outcomes)));
  },
});

const openPositionTool = defineTool({
  name: T.open_position,
  config: {
    annotations: MUTATING,
    title: 'Open position',
    description:
      'Convert a static investment account into a holding: record the quantity of an asset held in an ' +
      'investment account, at an average cost (default: the latest price, with a warning that P&L starts there; ' +
      'with no price either the call is refused — set a price or give avgCost). `remainingCash` (default 0) ' +
      "becomes the account's initialBalance in the SAME write, so the old static value and the holding are never " +
      'counted together; the cash it replaced is remembered, so deleting the opening gives it back. One opening ' +
      `per account and asset (enforced by the database): edit it with ${T.update_investment_event}. Not a ` +
      'transaction — nothing here touches spending summaries. Positions are derived from events, never stored; ' +
      `read them with ${T.get_portfolio}.`,
    inputSchema: OpenPositionSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => openPosition(deps, args).map(accountAdapters.outcomeToDb).map(investmentAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listInvestmentEventsTool = defineTool({
  name: T.list_investment_events,
  config: {
    annotations: READ_ONLY,
    title: 'List investment events',
    description:
      'The events that make up the positions (today: openings), oldest first, optionally for one account and/or ' +
      `asset. Each carries its id, for ${T.update_investment_event} / ${T.delete_investment_event}.`,
    inputSchema: ListInvestmentEventsSchema.shape,
  },
  handle: async (args, { deps }) => fromResult(await listInvestmentEvents(deps, args)),
});

const updateInvestmentEventTool = defineTool({
  name: T.update_investment_event,
  config: {
    annotations: MUTATING,
    title: 'Update investment event',
    description:
      'Change the quantity, average cost, date or note of an event by id. Only provided fields change; the ' +
      'position is recomputed from its events on the next read.',
    inputSchema: UpdateInvestmentEventSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => updateInvestmentEvent(deps, args).map(investmentAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const deleteInvestmentEventTool = defineTool({
  name: T.delete_investment_event,
  config: {
    annotations: MUTATING,
    title: 'Delete investment event',
    description:
      `Delete an event by id; the position it opened disappears from ${T.get_portfolio}. The cash that stayed in the ` +
      'account (its initialBalance) stays as it is, except that deleting an opening gives back, in the same write, ' +
      'the initialBalance that opening replaced (`restoredCash` in the response; an opening that replaced nothing ' +
      `restores nothing) — adjust it afterwards with ${T.update_account} if needed. An id that isn't yours or is ` +
      'already gone deletes nothing ({ deleted: false }).',
    inputSchema: DeleteInvestmentEventSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => deleteInvestmentEvent(deps, args).map(investmentAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const getPortfolioTool = defineTool({
  name: T.get_portfolio,
  config: {
    annotations: READ_ONLY,
    title: 'Get portfolio',
    description:
      'The positions, valued at read time: quantity, average cost, latest price, market value, cost basis and ' +
      'unrealized P&L, in the asset currency and in the base currency, each with `asOf`, `stale`, `noPrice` and ' +
      '`noRate`. A position with no price or no exchange rate is listed with null values — never 0 — and named in ' +
      '`totals.excluded`. Also totals in the base currency and the allocation by asset class and by currency. ' +
      'Optionally one account by name.',
    inputSchema: GetPortfolioSchema.shape,
  },
  handle: async (args, { deps }) => fromResult(await getPortfolio(deps, args)),
});

export const investmentTools = [
  registerAssetTool,
  listAssetsTool,
  setAssetPricesTool,
  openPositionTool,
  listInvestmentEventsTool,
  updateInvestmentEventTool,
  deleteInvestmentEventTool,
  getPortfolioTool,
];
