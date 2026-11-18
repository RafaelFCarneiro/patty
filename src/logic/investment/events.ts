import type { Account } from '../../models/account.js';
import type { Asset } from '../../models/investment/asset.js';
import type {
  InvestmentEvent,
  InvestmentEventEntity,
  InvestmentEventView,
  OpenPositionResult,
  OpeningPlan,
  UpdateInvestmentEventInput,
} from '../../models/investment/core.js';
import { roundToDecimals } from '../money.js';
import { assetLabel } from './asset.js';
import { isOpening } from './positions.js';

export const eventView = (
  event: InvestmentEvent,
  account: Pick<Account, 'name'>,
  asset: Pick<Asset, 'symbol' | 'exchange'>,
): InvestmentEventView => ({
  id: event.id,
  account: account.name,
  asset: assetLabel(asset),
  type: event.type,
  date: event.date,
  quantity: event.quantity,
  avgCost: event.unitCost,
  note: event.note,
  replacedCash: event.replacedCash,
});

export const cashToRestore = (event: Pick<InvestmentEvent, 'type' | 'replacedCash'>): number | null =>
  isOpening(event) ? event.replacedCash : null;

export const openingResult = (
  plan: OpeningPlan,
  account: Pick<Account, 'name'>,
  asset: Asset,
  decimals: number,
): OpenPositionResult => ({
  ...eventView(plan.event, account, asset),
  costBasis: roundToDecimals(plan.event.quantity * plan.event.unitCost, decimals),
  warnings: plan.warnings,
});

const keepUnlessGiven = <T>(given: T | undefined, current: T): T => given ?? current;

const clearsNote = (patch: UpdateInvestmentEventInput): boolean => patch.note === null;

export const mergeEventPatch = (
  existing: InvestmentEventEntity,
  patch: UpdateInvestmentEventInput,
): InvestmentEventEntity => ({
  ...existing,
  quantity: keepUnlessGiven(patch.quantity, existing.quantity),
  unitCost: keepUnlessGiven(patch.avgCost, existing.unitCost),
  date: keepUnlessGiven(patch.date, existing.date),
  note: clearsNote(patch) ? null : keepUnlessGiven(patch.note, existing.note),
});
