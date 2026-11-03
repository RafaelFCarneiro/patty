import * as R from 'remeda';
import {
  DemoFunding,
  type DemoBudgetShape,
  type DemoFixedLine,
  type DemoPendingLine,
  type DemoSpendLine,
  type DemoTripItem,
} from '../../../../models/demo/core.js';
import { CATEGORIES, DefaultCategoryId } from '../categories.js';

/** A seeded category's canonical (English) name — the one every locale's category lookup resolves. */
export const CATEGORY_NAME: Readonly<Record<DefaultCategoryId, string>> = R.mapToObj(CATEGORIES, (category) => [
  category.id,
  category.name,
]);

const C = DefaultCategoryId.enum;

/** The two tags the Spanish packs (Mexico and Colombia) share. */
export const SPANISH_TAGS = { work: 'trabajo', family: 'familia' } as const;

/** Budgets are sized against last month's spend: food and leisure were over budget, the rest comfortably under. */
export const BUDGET_SHAPES: readonly DemoBudgetShape[] = [
  { category: CATEGORY_NAME[C['cat-food']], factor: 0.75 },
  { category: CATEGORY_NAME[C['cat-leisure']], factor: 0.8 },
  { category: CATEGORY_NAME[C['cat-transport']], factor: 1.3 },
  { category: CATEGORY_NAME[C['cat-shopping']], factor: 1.35 },
  { category: CATEGORY_NAME[C['cat-health']], factor: 1.5 },
];

/** A recurring purchase, written the way a pack reads: where, what, how much, how often. */
export const spendLine = (
  via: DemoFunding,
  category: DefaultCategoryId,
  description: string,
  range: readonly [min: number, max: number],
  perMonth: number,
  tag?: string,
): DemoSpendLine => ({
  description,
  category: CATEGORY_NAME[category],
  via,
  min: range[0],
  max: range[1],
  perMonth,
  ...(tag ? { tag } : {}),
});

export const fixedLine = (
  category: DefaultCategoryId,
  description: string,
  amount: number,
  day: number,
): DemoFixedLine => ({ description, category: CATEGORY_NAME[category], amount, day });

export const tripItem = (
  dayOffset: number,
  via: DemoFunding,
  category: DefaultCategoryId,
  description: string,
  amount: number,
): DemoTripItem => ({ description, category: CATEGORY_NAME[category], via, amount, dayOffset });

export const pendingLine = (
  category: DefaultCategoryId,
  description: string,
  amount: number,
  daysAhead: number,
  income = false,
): DemoPendingLine => ({
  description,
  category: CATEGORY_NAME[category],
  via: DemoFunding.enum.checking,
  amount,
  daysAhead,
  ...(income ? { income } : {}),
});
