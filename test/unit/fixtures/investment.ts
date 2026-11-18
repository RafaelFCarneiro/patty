import { AccountType, type Account } from '../../../src/models/account.js';
import { AssetClass, AssetPricing, type Asset, type AssetPrice } from '../../../src/models/asset.js';
import type { CurrencyRate } from '../../../src/models/currency-rate.js';
import { InvestmentEventType, type InvestmentEvent } from '../../../src/models/investment.js';
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

export const investmentAccount = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-inv',
  name: 'Nu Holdings (NYSE:NU)',
  type: AccountType.enum.investment,
  currency: USD,
  initialBalance: 0,
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
  replacedCash: null,
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
