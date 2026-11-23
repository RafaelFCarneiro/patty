import { ok, ResultAsync, safeTry } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import * as persistence from '../../logic/persistence.js';
import {
  ASSET_ENTITY_TAG,
  ASSET_PRICE_ENTITY_TAG,
  type AssetEntity,
  type AssetPriceEntity,
  type AssetPriceView,
  type AssetView,
  type PricePlan,
  type RegisterPlan,
  type ListAssetsInput,
  type RegisterAsset,
  type RegisterAssetResult,
  type SetAssetPriceInput,
} from '../../models/investment/asset.js';
import type { Deps } from '../deps.js';
import { resolveAssetRef } from '../resolve.js';
import * as assetRules from '../../logic/investment/asset.js';
import * as timestamp from '../../logic/timestamp.js';

const registrationWrites = (plan: RegisterPlan, existing: AssetEntity | null): Persistable[] => {
  if (plan.created) return [persistence.insert({ entity: ASSET_ENTITY_TAG, model: plan.asset })];
  return existing && plan.renamed
    ? [persistence.update({ entity: ASSET_ENTITY_TAG, model: { ...existing, name: plan.asset.name } })]
    : [];
};

export const registerAsset = (
  deps: Deps,
  input: RegisterAsset,
): ResultAsync<FlowOutcome<RegisterAssetResult>, AppError> => {
  const registration = assetRules.normalizeRegistration(input);
  return ResultAsync.fromSafePromise(deps.assets.findByKey(registration.symbol, registration.exchange)).map(
    (existing) => {
      const plan = assetRules.planRegister(deps.newId(), registration, existing && assetRules.fromEntity(existing));
      return { persist: registrationWrites(plan, existing), response: assetRules.registerResult(plan) };
    },
  );
};

const priceWrite = (plan: PricePlan, existing: AssetPriceEntity | null): Persistable =>
  existing
    ? persistence.update({ entity: ASSET_PRICE_ENTITY_TAG, model: { ...plan.price, version: existing.version } })
    : persistence.insert({ entity: ASSET_PRICE_ENTITY_TAG, model: plan.price });

export const setAssetPrice = (
  deps: Deps,
  input: SetAssetPriceInput,
): ResultAsync<FlowOutcome<AssetPriceView>, AppError> =>
  safeTry(async function* () {
    const asset = yield* resolveAssetRef(deps, input.asset);
    const existing = await deps.assetPrices.findAt(asset.id, timestamp.canonical(input.asOf));
    const plan = assetRules.planPrice(deps.newId(), asset, input, existing);
    return ok({ persist: [priceWrite(plan, existing)], response: plan.view });
  });

export const listAssets = async (deps: Deps, filter: ListAssetsInput): Promise<AssetView[]> => {
  const [assets, prices] = await Promise.all([deps.assets.list(), deps.assetPrices.latest()]);
  return R.pipe(
    assets,
    R.map(assetRules.fromEntity),
    R.map(assetRules.withLatestPrice(prices, deps.clock(), deps.priceStaleness)),
    R.filter(assetRules.matchesListFilter(filter)),
  );
};
