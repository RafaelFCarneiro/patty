import { AccountType, type Account } from '../../../src/models/account.js';
import { AssetClass, AssetPricing, type Asset, type AssetPrice } from '../../../src/models/investment/asset.js';
import type { CurrencyRate } from '../../../src/models/currency-rate.js';
import {
  InvestmentEventType,
  type InvestmentEvent,
  type ValuationContext,
} from '../../../src/models/investment/core.js';
import { CurrencyCode } from '../../../src/models/money.js';

const { USD, BRL } = CurrencyCode.enum;

export const NOW = new Date('2026-11-18T12:00:00.000Z');

export const nuAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'asset-nu',
  symbol: 'NU',
  exchange: 'NYSE',
  name: 'Nu Holdings',
  assetClass: AssetClass.enum.stock,
  currency: USD,
  pricing: AssetPricing.enum.market,
  ...overrides,
});

export const kncrAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'asset-kncr',
  symbol: 'KNCR11',
  exchange: 'B3',
  name: 'Kinea Rendimentos',
  assetClass: AssetClass.enum.reit,
  currency: BRL,
  pricing: AssetPricing.enum.market,
  ...overrides,
});

export const cdbAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'asset-cdb',
  symbol: 'CDB-ITAU',
  exchange: 'ITAU',
  name: 'CDB Itaú',
  assetClass: AssetClass.enum.fixed_income,
  currency: BRL,
  pricing: AssetPricing.enum.manual,
  ...overrides,
});

export const priceOf = (
  asset: Pick<Asset, 'id'>,
  price: number,
  asOf: string,
  id = `price-${asset.id}`,
): AssetPrice => ({
  id,
  assetId: asset.id,
  price,
  asOf,
  source: null,
});

export const investmentAccount = (
  overrides: Partial<Account & { cashBeforeHoldings: number | null }> = {},
): Account & { cashBeforeHoldings: number | null } => ({
  id: 'acc-inv',
  name: 'Nu Holdings (NYSE:NU)',
  type: AccountType.enum.investment,
  currency: USD,
  initialBalance: 0,
  cashBeforeHoldings: null,
  ...overrides,
});

export const openingEvent = (overrides: Partial<InvestmentEvent> = {}): InvestmentEvent => ({
  id: 'event-1',
  accountId: 'acc-inv',
  assetId: 'asset-nu',
  type: InvestmentEventType.enum.opening,
  date: '2026-11-01',
  quantity: 10,
  unitCost: 8,
  note: null,
  ...overrides,
});

export const rateOf = (fromCode: CurrencyCode, toCode: CurrencyCode, rate: number, asOf: string): CurrencyRate => ({
  id: `rate-${fromCode}-${toCode}`,
  fromCode,
  toCode,
  rate,
  asOf,
  source: null,
});

export const THRESHOLDS = {
  rateThresholds: { fiatHours: 24, cryptoHours: 1 },
  priceThresholds: { marketHours: 72, manualDays: 31 },
};

export const FRESH = '2026-11-18T12:00:00.000Z';

export const hoursBeforeNow = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const DECIMALS = { USD: 2, BRL: 2, BTC: 8 } as const;

export const valuationContext = (overrides: Partial<ValuationContext> = {}): ValuationContext => ({
  rates: [rateOf(USD, BRL, 5, FRESH), rateOf(BRL, USD, 0.2, FRESH)],
  baseCurrency: BRL,
  decimalsOf: (code) => DECIMALS[code as keyof typeof DECIMALS] ?? 2,
  now: NOW,
  ...THRESHOLDS,
  ...overrides,
});

export const NO_ACTIVITY = {
  accountDecimals: 2,
  activity: { transactions: 0, movements: { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 } },
};
