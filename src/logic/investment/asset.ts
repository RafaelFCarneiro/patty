import type { Result } from 'neverthrow';
import * as R from 'remeda';
import {
  type Asset,
  type AssetPrice,
  type AssetPriceBulkItem,
  type AssetEntity,
  type AssetPriceEntity,
  type AssetPriceView,
  type AssetPricing,
  AssetPricing as AssetPricingEnum,
  EXCHANGE_SEPARATOR,
  type AssetRef,
  type AssetView,
  type ListAssetsInput,
  type PricePlan,
  type PriceStalenessThresholds,
  type RegisterPlan,
  type RegisterAsset,
  type RegisterAssetResult,
  type SetAssetPriceInput,
} from '../../models/investment/asset.js';
import type { BulkItemShape } from '../../models/bulk.js';
import type { Resolution } from '../../models/resolution.js';
import * as timestamp from '../timestamp.js';
import { buildBulkItems, toBulkItem as toGenericBulkItem } from '../bulk-item.js';
import { fold } from '../resolve.js';
import { isStale } from '../staleness.js';
import { HOURS_PER_DAY, StalenessClass } from '../../models/timestamp.js';

const PRICE_STALENESS = {
  [AssetPricingEnum.enum.market]: {
    kind: StalenessClass.enum.market_price,
    hours: (thresholds) => thresholds.marketHours,
  },
  [AssetPricingEnum.enum.manual]: {
    kind: StalenessClass.enum.manual_price,
    hours: (thresholds) => thresholds.manualDays * HOURS_PER_DAY,
  },
} as const satisfies Record<
  AssetPricing,
  { kind: StalenessClass; hours: (thresholds: PriceStalenessThresholds) => number }
>;

export const isPriceStale = (
  pricing: AssetPricing,
  asOf: string,
  now: Date,
  thresholds: PriceStalenessThresholds,
): boolean => {
  const { kind, hours } = PRICE_STALENESS[pricing];
  return isStale(kind, asOf, now, hours(thresholds));
};

export const label = (asset: Pick<Asset, 'symbol' | 'exchange'>): string =>
  `${asset.exchange}${EXCHANGE_SEPARATOR}${asset.symbol}`;

const normalizeCode = (code: string): string => code.trim().toUpperCase();

export const normalizeRegistration = (input: RegisterAsset): RegisterAsset => ({
  ...input,
  symbol: normalizeCode(input.symbol),
  exchange: normalizeCode(input.exchange),
  name: input.name.trim(),
});

export const parseRef = (ref: string): AssetRef => {
  const [head = '', ...rest] = ref.split(EXCHANGE_SEPARATOR);
  return rest.length === 0
    ? { symbol: normalizeCode(head), exchange: null }
    : { symbol: normalizeCode(rest.join(EXCHANGE_SEPARATOR)), exchange: normalizeCode(head) };
};

const matchesRef =
  ({ symbol, exchange }: AssetRef) =>
  (asset: Asset): boolean =>
    asset.symbol === symbol && (exchange === null || asset.exchange === exchange);

const matchesName = (query: string) => (asset: Asset) => fold(asset.name) === fold(query);

export const resolve = (assets: readonly Asset[], ref: string): Resolution<Asset> => {
  const bySymbol = R.filter(assets, matchesRef(parseRef(ref)));
  const matches = bySymbol.length > 0 ? bySymbol : R.filter(assets, matchesName(ref));
  const [single] = matches;
  if (single && matches.length === 1) return { kind: 'found', entity: single };
  const candidates = R.map(matches.length > 1 ? matches : assets, label);
  return matches.length > 1 ? { kind: 'ambiguous', query: ref, candidates } : { kind: 'none', query: ref, candidates };
};

export const fromEntity = (entity: Asset | AssetEntity): Asset => R.omit(entity as AssetEntity, ['version']);

const DIFFERING_FIELDS = ['assetClass', 'currency', 'pricing'] as const;

const differingWarnings = (existing: Asset, input: RegisterAsset): string[] =>
  R.pipe(
    DIFFERING_FIELDS,
    R.filter((field) => existing[field] !== input[field]),
    R.map(
      (field) => `${field} stays ${existing[field]} — the registered asset is not changed (requested ${input[field]})`,
    ),
  );

export const planRegister = (id: string, input: RegisterAsset, existing: Asset | null): RegisterPlan => {
  if (existing === null) return { asset: { id, ...input }, created: true, renamed: false, warnings: [] };
  const renamed = existing.name !== input.name;
  return {
    asset: renamed ? { ...existing, name: input.name } : existing,
    created: false,
    renamed,
    warnings: differingWarnings(existing, input),
  };
};

export const registerResult = (plan: RegisterPlan): RegisterAssetResult => ({
  asset: plan.asset,
  created: plan.created,
  ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
});

export const planPrice = (
  id: string,
  asset: Asset,
  input: SetAssetPriceInput,
  existing: AssetPriceEntity | null,
): PricePlan => {
  const asOf = timestamp.canonical(input.asOf);
  const price: AssetPrice = {
    id: existing?.id ?? id,
    assetId: asset.id,
    price: input.price,
    asOf,
    source: input.source ?? null,
  };
  return { price, view: { asset: label(asset), price: input.price, asOf, source: input.source } };
};

const bulkShape = <E>(): BulkItemShape<
  SetAssetPriceInput,
  AssetPriceView,
  E,
  { price: AssetPriceView },
  { asset: string; error: E }
> => ({
  applied: (price) => ({ price }),
  refused: (input, error) => ({ asset: input.asset, error }),
});

export const toBulkItem = <E>(input: SetAssetPriceInput, result: Result<AssetPriceView, E>): AssetPriceBulkItem<E> =>
  toGenericBulkItem(input, result, bulkShape<E>());

export const buildBulkResult = <E>(
  items: readonly SetAssetPriceInput[],
  outcomes: readonly Result<AssetPriceView, E>[],
): AssetPriceBulkItem<E>[] => buildBulkItems(items, outcomes, bulkShape<E>());

export const latestPrice = <P extends Pick<AssetPrice, 'assetId' | 'asOf'>>(
  prices: readonly P[],
  assetId: string,
): P | undefined =>
  R.pipe(
    prices,
    R.filter((price) => price.assetId === assetId),
    R.firstBy([(price) => timestamp.parse(price.asOf).getTime(), 'desc']),
  );

export const withLatestPrice =
  (prices: readonly AssetPrice[], now: Date, thresholds: PriceStalenessThresholds) =>
  (asset: Asset): AssetView => {
    const latest = latestPrice(prices, asset.id);
    return {
      ...asset,
      price: latest?.price ?? null,
      priceAsOf: latest?.asOf ?? null,
      stale: latest ? isPriceStale(asset.pricing, latest.asOf, now, thresholds) : false,
      noPrice: latest === undefined,
    };
  };

export const needsRefresh = (view: AssetView): boolean => view.noPrice || view.stale;

export const matchesListFilter =
  ({ assetClass, staleOnly }: ListAssetsInput) =>
  (view: AssetView): boolean =>
    (assetClass === undefined || view.assetClass === assetClass) && (!staleOnly || needsRefresh(view));
