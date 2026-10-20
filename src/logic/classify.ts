import * as R from 'remeda';
import type { ClassifyOutcome, MerchantMatch } from '../models/transaction.js';

export const weightToConfidence = (weight: number): number => Math.min(0.95, 0.5 + 0.1 * Math.max(0, weight));

export const userClassification = (category: { id: string; name: string }): ClassifyOutcome => ({
  method: 'user',
  confidence: 1,
  categoryId: category.id,
  categoryName: category.name,
});

export const pickClassification = (matches: readonly MerchantMatch[]): ClassifyOutcome => {
  const best = R.firstBy(matches, [(m) => m.weight, 'desc']);
  if (!best) return { method: 'none', confidence: 0 };
  return {
    method: best.origin,
    confidence: weightToConfidence(best.weight),
    categoryId: best.categoryId,
    categoryName: best.categoryName,
    merchantKey: best.merchantKey,
  };
};
