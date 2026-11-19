import type { Account } from '../../models/account.js';
import type { Asset } from '../../models/investment/asset.js';
import {
  InvestmentEventType,
  investmentErrors,
  type InvestmentError,
  type InvestmentEvent,
  type InvestmentEventEntity,
  type InvestmentEventView,
  type UpdateInvestmentEventInput,
} from '../../models/investment/core.js';
import * as assetRules from './asset.js';

export const view = (
  event: InvestmentEvent,
  account: Pick<Account, 'name'>,
  asset: Pick<Asset, 'symbol' | 'exchange'>,
): InvestmentEventView => ({
  id: event.id,
  account: account.name,
  asset: assetRules.label(asset),
  type: event.type,
  date: event.date,
  quantity: event.quantity,
  avgCost: event.unitCost,
  note: event.note,
  replacedCash: event.replacedCash,
});

export const isOpening = (event: Pick<InvestmentEvent, 'type'>): boolean =>
  event.type === InvestmentEventType.enum.opening;

export const cashToRestore = (event: Pick<InvestmentEvent, 'type' | 'replacedCash'>): number | null =>
  isOpening(event) ? event.replacedCash : null;

const keepUnlessGiven = <T>(given: T | undefined, current: T): T => given ?? current;

const clearsNote = (patch: UpdateInvestmentEventInput): boolean => patch.note === null;

export const mergePatch = (
  existing: InvestmentEventEntity,
  patch: UpdateInvestmentEventInput,
): InvestmentEventEntity => ({
  ...existing,
  quantity: keepUnlessGiven(patch.quantity, existing.quantity),
  unitCost: keepUnlessGiven(patch.avgCost, existing.unitCost),
  date: keepUnlessGiven(patch.date, existing.date),
  note: clearsNote(patch) ? null : keepUnlessGiven(patch.note, existing.note),
});

export const refusalToDelete = (
  event: Pick<InvestmentEvent, 'type' | 'replacedCash'>,
  siblings: readonly InvestmentEvent[],
  account: Pick<Account, 'name'>,
): InvestmentError | null =>
  cashToRestore(event) !== null && siblings.length > 0 ? investmentErrors.otherPositionsRemain(account.name) : null;
