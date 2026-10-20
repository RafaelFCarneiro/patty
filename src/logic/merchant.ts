import {
  MERCHANT_CATEGORY_ENTITY_TAG,
  MERCHANT_ENTITY_TAG,
  type MerchantCategoryEdge,
  NOISE_PREFIXES,
  MERCHANT_LEARNING_WEIGHT_DELTA,
} from '../models/merchant.js';
import type { Persistable } from '@rfc0/effect-runner';
import { ClassificationMethod } from '../models/transaction.js';
import { insert } from './persistence.js';

export const normalizeMerchant = (description: string): string =>
  description
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(NOISE_PREFIXES, '')
    .replace(/[*_#-]/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const resolveMerchantCorrection = (
  existing: { merchant?: string; categoryId?: string },
  newCategoryId: string | null | undefined,
): MerchantCategoryEdge | null => {
  if (!newCategoryId || newCategoryId === existing.categoryId || !existing.merchant) return null;
  return {
    merchantKey: existing.merchant,
    categoryId: newCategoryId,
    weightDelta: MERCHANT_LEARNING_WEIGHT_DELTA,
    origin: ClassificationMethod.enum.history,
  };
};

export const withMerchant = (persist: readonly Persistable[], merchantKey: string | undefined): Persistable[] =>
  merchantKey ? [insert({ entity: MERCHANT_ENTITY_TAG, model: { key: merchantKey } }), ...persist] : [...persist];

export const withMerchantLearning = (
  persist: readonly Persistable[],
  correction: MerchantCategoryEdge | null,
): Persistable[] =>
  correction
    ? [
        ...persist,
        insert({ entity: MERCHANT_ENTITY_TAG, model: { key: correction.merchantKey } }),
        insert({ entity: MERCHANT_CATEGORY_ENTITY_TAG, model: correction }),
      ]
    : [...persist];
