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
  type AssetRef,
  type AssetView,
  type ListAssetsInput,
  type PriceStalenessThresholds,
  type RegisterAsset,
  type RegisterAssetResult,
  type SetAssetPriceInput,
} from '../models/asset.js';
import type { Resolution } from '../models/resolution.js';
import { buildBulkItems, toBulkItem as toGenericBulkItem, type BulkItemShape } from './bulk-item.js';
import { fold } from './resolve.js';
import { isStale } from './currency-rate.js';

const HOURS_PER_DAY = 24;
const EXCHANGE_SEPARATOR = ':';

/** The price's own staleness window in hours, per pricing class (ADR-038 §4): market quotes age in hours, manually
 *  posted values in days. */
const STALE_AFTER_HOURS = {
  [AssetPricingEnum.enum.market]: (thresholds) => thresholds.marketHours,
  [AssetPricingEnum.enum.manual]: (thresholds) => thresholds.manualDays * HOURS_PER_DAY,
} as const satisfies Record<AssetPricing, (thresholds: PriceStalenessThresholds) => number>;

export const isPriceStale = (
  pricing: AssetPricing,
  asOf: string,
  now: Date,
  thresholds: PriceStalenessThresholds,
): boolean => isStale(asOf, now, STALE_AFTER_HOURS[pricing](thresholds));

/** An asset's own `EXCHANGE:SYMBOL` label — the form an `asset` reference accepts back. */
export const assetLabel = (asset: Pick<Asset, 'symbol' | 'exchange'>): string =>
  `${asset.exchange}${EXCHANGE_SEPARATOR}${asset.symbol}`;

/** Symbols and exchanges are compared upper-cased, so `nu` and `NU` are the same asset. */
const normalizeCode = (code: string): string => code.trim().toUpperCase();

export const normalizeRegistration = (input: RegisterAsset): RegisterAsset => ({
  ...input,
  symbol: normalizeCode(input.symbol),
  exchange: normalizeCode(input.exchange),
  name: input.name.trim(),
});

export const parseAssetRef = (ref: string): AssetRef => {
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

/** Resolves what a person typed to an asset: `SYMBOL`, `EXCHANGE:SYMBOL`, or the asset's exact name. A symbol quoted
 *  on two exchanges is ambiguous until the exchange is given. */
export const resolveAsset = (assets: readonly Asset[], ref: string): Resolution<Asset> => {
  const bySymbol = R.filter(assets, matchesRef(parseAssetRef(ref)));
  const matches = bySymbol.length > 0 ? bySymbol : R.filter(assets, matchesName(ref));
  const [single] = matches;
  if (single && matches.length === 1) return { kind: 'found', entity: single };
  const candidates = R.map(matches.length > 1 ? matches : assets, assetLabel);
  return matches.length > 1 ? { kind: 'ambiguous', query: ref, candidates } : { kind: 'none', query: ref, candidates };
};

/** The asset without its persistence-side version token, which never reaches a response. */
export const toAsset = (entity: Asset | AssetEntity): Asset => R.omit(entity as AssetEntity, ['version']);

export type RegisterPlan = { asset: Asset; created: boolean; renamed: boolean; warnings: string[] };

const DIFFERING_FIELDS = ['assetClass', 'currency', 'pricing'] as const;

const differingWarnings = (existing: Asset, input: RegisterAsset): string[] =>
  R.pipe(
    DIFFERING_FIELDS,
    R.filter((field) => existing[field] !== input[field]),
    R.map(
      (field) => `${field} stays ${existing[field]} — the registered asset is not changed (requested ${input[field]})`,
    ),
  );

/** Registering is idempotent on symbol + exchange: an existing asset is returned unchanged, except that a new name
 *  renames it. A request that disagrees on class, currency or pricing is answered with the registered values and a
 *  warning for each. */
export const planRegisterAsset = (id: string, input: RegisterAsset, existing: Asset | null): RegisterPlan => {
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

/** The instant as canonical UTC, so the text order of stored prices is their time order. */
export const canonicalTimestamp = (asOf: string): string => new Date(asOf).toISOString();

export type PricePlan = { price: AssetPrice; view: AssetPriceView };

/** A price for an asset at an instant: the stored row for that instant is revised, otherwise a new point of the
 *  history is added. */
export const planAssetPrice = (
  id: string,
  asset: Asset,
  input: SetAssetPriceInput,
  existing: AssetPriceEntity | null,
): PricePlan => {
  const asOf = canonicalTimestamp(input.asOf);
  const price: AssetPrice = {
    id: existing?.id ?? id,
    assetId: asset.id,
    price: input.price,
    asOf,
    source: input.source ?? null,
  };
  return { price, view: { asset: assetLabel(asset), price: input.price, asOf, source: input.source } };
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

/** The newest price of one asset's history, by instant. */
export const latestPrice = <P extends Pick<AssetPrice, 'assetId' | 'asOf'>>(
  prices: readonly P[],
  assetId: string,
): P | undefined =>
  R.pipe(
    prices,
    R.filter((price) => price.assetId === assetId),
    R.firstBy([(price) => new Date(price.asOf).getTime(), 'desc']),
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

/** The `list_assets` filter: an optional class, and optionally only what needs a fresh price. */
export const matchesListFilter =
  ({ assetClass, staleOnly }: ListAssetsInput) =>
  (view: AssetView): boolean =>
    (assetClass === undefined || view.assetClass === assetClass) && (!staleOnly || needsRefresh(view));
