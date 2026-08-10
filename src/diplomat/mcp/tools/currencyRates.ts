import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listExchangeRates, setExchangeRate } from '../../../controllers/currencyRates.js';
import { buildBulkResult } from '../../../logic/currencyRate.js';
import { SetExchangeRateSchema } from '../../../models/currencyRate.js';
import { SetExchangeRatesSchema } from '../../../wire/in/currencyRates.js';
import * as currencyRateAdapters from '../../../adapters/currencyRates.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';

const RATE_TOOL_DESCRIPTION_PREFIX =
  'FinTrack never fetches exchange rates itself (local-first, zero external calls — ADR-026). ' +
  'The AI agent is responsible for sourcing current rates (e.g. PTAX for fiat, a crypto price API) ' +
  'and upserting them here so read-time valuation has data to work with. ';

export const registerCurrencyRateTools = (server: McpServer, ctx: McpContext): void => {
  const { deps, runEffects, runEffectsSequence } = ctx;

  server.registerTool(
    'set_exchange_rate',
    {
      title: 'Set exchange rate',
      description:
        RATE_TOOL_DESCRIPTION_PREFIX +
        'Upserts one (from, to) rate: 1 unit of `from` = `rate` units of `to`, as of `asOf`. ' +
        'A pair that already has a stored rate is overwritten (latest wins) — this is not a history log.',
      inputSchema: SetExchangeRateSchema.shape,
    },
    async (args) => {
      const flow = () => setExchangeRate(deps, args).map(currencyRateAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'set_exchange_rates',
    {
      title: 'Set exchange rates (bulk)',
      description:
        RATE_TOOL_DESCRIPTION_PREFIX +
        'Upserts several (from, to) rates in one call, same semantics as set_exchange_rate per item. ' +
        "Partial success: one pair's failure (e.g. from === to) does not block the others — check each " +
        "item's status in the response.",
      inputSchema: SetExchangeRatesSchema.shape,
    },
    async (args) => {
      const outcomes = await runEffectsSequence(
        args.rates,
        (item) => () => setExchangeRate(deps, item).map(currencyRateAdapters.outcomeToDb),
      );
      return json(currencyRateAdapters.bulkResultToWireOut(buildBulkResult(args.rates, outcomes)));
    },
  );

  server.registerTool(
    'list_exchange_rates',
    {
      title: 'List exchange rates',
      description:
        'All stored exchange rates, each with its own `asOf`. Staleness is not evaluated here — this ' +
        'is the raw cached table (ADR-026); use it to decide which pairs need refreshing.',
      inputSchema: {},
    },
    async () => json(await listExchangeRates(deps)),
  );
};
