import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { AssetClass, AssetPricing, AssetTimestamp } from './asset.js';
import { IsoTimestamp } from './currency-rate.js';
import { IsoDate } from './date.js';
import type { NotFound, ValidationError } from './error.js';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';

/** Entity tag for an owned investment event (ADR-038 §1). */
export const INVESTMENT_EVENT_ENTITY_TAG = 'investment_event';

/** Every kind of event the schema can hold; step 1's flows accept only `opening` (buy/sell/split arrive with ADR-038
 *  step 2, which therefore needs no migration). */
export const InvestmentEventType = z.enum(['opening', 'buy', 'sell', 'split']);
export type InvestmentEventType = z.infer<typeof InvestmentEventType>;

export const InvestmentEventSchema = z.object({
  id: Id.describe('Unique investment event identifier'),
  accountId: Id.describe('The investment account that holds the position'),
  assetId: Id.describe('The asset held'),
  type: InvestmentEventType.describe('opening | buy | sell | split'),
  date: IsoDate.describe('YYYY-MM-DD the event takes effect'),
  quantity: z.number().positive().describe('Units; fractional shares allowed'),
  unitCost: z.number().nonnegative().describe('Cost of one unit in the asset currency (the average cost, for opening)'),
  note: z.string().nullable().describe('Free-text note, or null'),
  replacedCash: z
    .number()
    .nullable()
    .describe('The account initialBalance this opening replaced (given back when it is deleted); null if none'),
});
export type InvestmentEvent = z.infer<typeof InvestmentEventSchema>;

export const InvestmentEventEntitySchema = withPersistenceMeta(InvestmentEventSchema);
export type InvestmentEventEntity = z.infer<typeof InvestmentEventEntitySchema>;

const QUANTITY_DESCRIPTION = 'Units held; fractional shares allowed';
const AVG_COST_DESCRIPTION = 'Average cost of one unit in the asset currency';
const REFERENCE_DATE_DESCRIPTION = 'YYYY-MM-DD; defaults to today';

export const OpenPositionSchema = z.object({
  account: z.string().min(1).describe('Name of the investment account that holds the position'),
  asset: z.string().min(1).describe('Asset symbol (e.g. "NU"), or "EXCHANGE:SYMBOL" (e.g. "NYSE:NU") when ambiguous'),
  quantity: z.number().positive().describe(QUANTITY_DESCRIPTION),
  avgCost: z
    .number()
    .nonnegative()
    .optional()
    .describe(`${AVG_COST_DESCRIPTION}; omit to start P&L from the latest price (a warning says so)`),
  date: IsoDate.optional().describe(REFERENCE_DATE_DESCRIPTION),
  remainingCash: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Cash that stays in the account after the conversion; sets the account initialBalance in the same write so the ' +
        'old static value and the holding are never counted together. Default 0',
    ),
  note: z.string().min(1).optional().describe('Free-text note'),
});
export type OpenPositionInput = z.infer<typeof OpenPositionSchema>;

export const ListInvestmentEventsSchema = z.object({
  account: z.string().min(1).optional().describe('Only events of this investment account (by name)'),
  asset: z.string().min(1).optional().describe('Only events of this asset (symbol or "EXCHANGE:SYMBOL")'),
});
export type ListInvestmentEventsInput = z.infer<typeof ListInvestmentEventsSchema>;

export const UpdateInvestmentEventSchema = z.object({
  id: Id.describe('Event id, from the investment event list'),
  quantity: z.number().positive().optional().describe(QUANTITY_DESCRIPTION),
  avgCost: z.number().nonnegative().optional().describe(AVG_COST_DESCRIPTION),
  date: IsoDate.optional().describe('YYYY-MM-DD'),
  note: z.string().min(1).nullable().optional().describe('Free-text note; null clears it'),
});
export type UpdateInvestmentEventInput = z.infer<typeof UpdateInvestmentEventSchema>;

export const DeleteInvestmentEventResultSchema = z.object({
  deleted: z.boolean(),
  restoredCash: z
    .object({
      account: z.string().describe('Account name'),
      initialBalance: z.number().describe('The initialBalance the account was given back'),
    })
    .optional()
    .describe('Present when deleting an opening gave back the account cash that opening had replaced'),
});
export type DeleteInvestmentEventResult = z.infer<typeof DeleteInvestmentEventResultSchema>;

export const DeleteInvestmentEventSchema = z.object({
  id: Id.describe('Event id, from the investment event list'),
});
export type DeleteInvestmentEventInput = z.infer<typeof DeleteInvestmentEventSchema>;

export const InvestmentEventViewSchema = z.object({
  id: Id,
  account: z.string().describe('Account name'),
  asset: z.string().describe('EXCHANGE:SYMBOL'),
  type: InvestmentEventType,
  date: IsoDate,
  quantity: z.number(),
  avgCost: z.number().describe('Unit cost in the asset currency'),
  note: z.string().nullable(),
  replacedCash: z.number().nullable().describe('The account cash this opening replaced; deleting it restores it'),
});
export type InvestmentEventView = z.infer<typeof InvestmentEventViewSchema>;

export const OpenPositionResultSchema = InvestmentEventViewSchema.extend({
  costBasis: z.number().describe('quantity × avgCost, in the asset currency'),
  warnings: z.array(z.string()).describe('Things the caller should know, e.g. P&L starting at the latest price'),
});
export type OpenPositionResult = z.infer<typeof OpenPositionResultSchema>;

/** What the fold of an account's and asset's events says is held — derived, never stored (ADR-038 §2). */
export type Position = { accountId: string; assetId: string; quantity: number; avgCost: number };

export const PositionExclusionReason = z.enum(['no_price', 'no_rate']);
export type PositionExclusionReason = z.infer<typeof PositionExclusionReason>;

export const ExcludedPositionSchema = z.object({
  account: z.string().describe('Account name'),
  asset: z.string().describe('EXCHANGE:SYMBOL'),
  reason: PositionExclusionReason.describe(
    'no_price: no price on file | no_rate: no exchange rate to the base currency',
  ),
});
export type ExcludedPosition = z.infer<typeof ExcludedPositionSchema>;

/** A position valued in the base currency; absent (null on the valuation) when no rate converts it. */
export const BaseValuationSchema = z.object({
  currency: CurrencyCode.describe('The base currency these figures are expressed in'),
  rate: z.number().positive().describe('Exchange rate applied (1 when the asset already is in the base currency)'),
  rateAsOf: IsoTimestamp.describe('When the applied rate was observed/sourced'),
  costBasis: z.number(),
  marketValue: z.number().nullable().describe('Null when the position has no price — never 0'),
  unrealized: z.number().nullable(),
});
export type BaseValuation = z.infer<typeof BaseValuationSchema>;

export const PositionValuationSchema = z.object({
  accountId: Id,
  account: z.string().describe('Account name'),
  assetId: Id,
  asset: z.string().describe('EXCHANGE:SYMBOL'),
  name: z.string(),
  assetClass: AssetClass,
  pricing: AssetPricing,
  currency: CurrencyCode.describe('Asset (quote) currency'),
  quantity: z.number(),
  avgCost: z.number(),
  costBasis: z.number().describe('quantity × avgCost, in the asset currency'),
  price: z.number().nullable().describe('Latest price of one unit; null when none is on file'),
  priceAsOf: AssetTimestamp.nullable(),
  marketValue: z.number().nullable().describe('quantity × price in the asset currency; null with no price — never 0'),
  unrealized: z.number().nullable().describe('marketValue − costBasis in the asset currency'),
  base: BaseValuationSchema.nullable().describe('The same figures in the base currency; null with no exchange rate'),
  asOf: IsoTimestamp.nullable().describe('The older of the price and the rate used'),
  stale: z.boolean().describe('True when the price or the rate is older than its class allows'),
  noPrice: z.boolean(),
  noRate: z.boolean(),
});
export type PositionValuation = z.infer<typeof PositionValuationSchema>;

export const PortfolioTotalsSchema = z.object({
  baseCurrency: CurrencyCode,
  marketValue: z.number().describe('Sum of every valued position in the base currency'),
  costBasis: z.number().describe('Cost of the same positions in the base currency'),
  unrealized: z.number(),
  stale: z.boolean().describe('True when any contributing price or rate is stale'),
  asOf: IsoTimestamp.nullable().describe('The oldest contributing price or rate; null when nothing was valued'),
  excluded: z.array(ExcludedPositionSchema).describe('Positions left out of the totals, and why'),
});
export type PortfolioTotals = z.infer<typeof PortfolioTotalsSchema>;

export const AllocationSliceSchema = z.object({
  key: z.string().describe('The asset class or the currency'),
  value: z.number().describe('Market value in the base currency'),
  pct: z.number().describe('Share of the valued total, in percent'),
});
export type AllocationSlice = z.infer<typeof AllocationSliceSchema>;

export const PortfolioViewSchema = z.object({
  baseCurrency: CurrencyCode,
  positions: z.array(PositionValuationSchema),
  totals: PortfolioTotalsSchema,
  allocation: z.object({
    byAssetClass: z.array(AllocationSliceSchema),
    byCurrency: z.array(AllocationSliceSchema),
  }),
});
export type PortfolioView = z.infer<typeof PortfolioViewSchema>;

export const GetPortfolioSchema = z.object({
  account: z.string().min(1).optional().describe('Only this investment account (by name); omit for every account'),
});
export type GetPortfolioInput = z.infer<typeof GetPortfolioSchema>;

/** What an investment account adds to a balance once it holds positions (ADR-038 §6): its cash and its holdings. */
export const AccountHoldingsSchema = z.object({
  cashBalance: z.number().describe('The cash balance in the account currency — the same figure as `balance`'),
  holdingsValue: z.number().describe('Market value of the positions in the base currency'),
  baseCurrency: CurrencyCode,
  total: z.number().nullable().describe('Cash converted to the base currency + holdingsValue; null without a rate'),
  stale: z.boolean().describe('True when any contributing price or rate is stale'),
  asOf: IsoTimestamp.nullable(),
  excluded: z.array(ExcludedPositionSchema).describe('Positions left out of holdingsValue, and why'),
});
export type AccountHoldings = z.infer<typeof AccountHoldingsSchema>;

/** Holdings inside the consolidated net worth: already part of its `total`. */
export const NetWorthHoldingsSchema = z.object({
  value: z.number().describe('Market value of the valued positions in the base currency'),
  stale: z.boolean(),
  asOf: IsoTimestamp.nullable(),
  excluded: z.array(ExcludedPositionSchema),
});
export type NetWorthHoldings = z.infer<typeof NetWorthHoldingsSchema>;

export type InvestmentError = NotFound<'investment_event'> | ValidationError;

const NOT_AN_INVESTMENT_ACCOUNT = (account: string, type: string): string =>
  `account "${account}" is a ${type} account — positions live in investment accounts`;

export const investmentErrors = {
  notInvestmentAccount: (account: string, type: string): InvestmentError => ({
    code: 'validation',
    issues: [NOT_AN_INVESTMENT_ACCOUNT(account, type)],
  }),
  openingExists: (account: string, asset: string): InvestmentError => ({
    code: 'validation',
    issues: [`${account} already has an opening for ${asset} — update or delete that event instead`],
  }),
  noPriceNoCost: (asset: string): InvestmentError => ({
    code: 'validation',
    issues: [`no price is on file for ${asset} and no avgCost was given — set a price or give avgCost`],
  }),
  unknownEvent: (id: string): InvestmentError => ({ code: 'unknown_investment_event', query: id, candidates: [] }),
};

export const investmentWarnings = {
  costFromPrice: (asset: string, price: number, asOf: string): string =>
    `no avgCost given: P&L for ${asset} starts at the latest price (${price} as of ${asOf})`,
};
