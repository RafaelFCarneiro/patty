import type { Account } from '../../models/account.js';
import type { Asset } from '../../models/investment/asset.js';
import {
  InvestmentEventType,
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
});

export const isOpening = (event: Pick<InvestmentEvent, 'type'>): boolean =>
  event.type === InvestmentEventType.enum.opening;

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
