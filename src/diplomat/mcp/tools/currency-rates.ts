import { ToolName } from '../tool-name.js';
import { listExchangeRates, setExchangeRate } from '../../../controllers/currency-rates.js';
import { buildBulkResult } from '../../../logic/currency-rate.js';
import { SetExchangeRateSchema } from '../../../models/currency-rate.js';
import { SetExchangeRatesSchema } from '../../../wire/in/currency-rates.js';
import * as currencyRateAdapters from '../../../adapters/currency-rates.js';
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const RATE_TOOL_DESCRIPTION_PREFIX =
  'FinTrack never fetches exchange rates itself (local-first, zero external calls — ADR-026). ' +
  'The AI agent is responsible for sourcing current rates (e.g. PTAX for fiat, a crypto price API) ' +
  'and upserting them here so read-time valuation has data to work with. ';

const setExchangeRateDescription =
  RATE_TOOL_DESCRIPTION_PREFIX +
  'Upserts one (from, to) rate: 1 unit of `from` = `rate` units of `to`, as of `asOf`. ' +
  'A pair that already has a stored rate is overwritten (latest wins) — this is not a history log.';

const setExchangeRateTool = defineTool({
  name: ToolName.enum.set_exchange_rate,
  config: {
    annotations: MUTATING,
    title: 'Set exchange rate',
    description: setExchangeRateDescription,
    inputSchema: SetExchangeRateSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => setExchangeRate(deps, args).map(currencyRateAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const setExchangeRatesDescription =
  RATE_TOOL_DESCRIPTION_PREFIX +
  'Upserts several (from, to) rates in one call, same semantics as set_exchange_rate per item. ' +
  "Partial success: one pair's failure (e.g. from === to) does not block the others — check each " +
  "item's status in the response.";

const setExchangeRatesTool = defineTool({
  name: ToolName.enum.set_exchange_rates,
  config: {
    annotations: MUTATING,
    title: 'Set exchange rates (bulk)',
    description: setExchangeRatesDescription,
    inputSchema: SetExchangeRatesSchema.shape,
  },
  // Orchestration (plan → run each item → bulk result) that belongs in a controller; kept as one named step here.
  handle: async (args, { deps, runEffectsSequence }) => {
    const outcomes = await runEffectsSequence(
      args.rates,
      (item) => () => setExchangeRate(deps, item).map(currencyRateAdapters.outcomeToDb),
    );
    return json(currencyRateAdapters.bulkResultToWireOut(buildBulkResult(args.rates, outcomes)));
  },
});

const listExchangeRatesDescription =
  'All stored exchange rates, each with its own `asOf`. Staleness is not evaluated here — this ' +
  'is the raw cached table (ADR-026); use it to decide which pairs need refreshing.';

const listExchangeRatesTool = defineTool({
  name: ToolName.enum.list_exchange_rates,
  config: {
    annotations: READ_ONLY,
    title: 'List exchange rates',
    description: listExchangeRatesDescription,
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await listExchangeRates(deps));
  },
});

export const currencyRateTools = [setExchangeRateTool, setExchangeRatesTool, listExchangeRatesTool];
