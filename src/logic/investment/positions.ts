import * as R from 'remeda';
import {
  InvestmentEventType,
  type InvestmentEvent,
  type Position,
  type PositionState,
} from '../../models/investment/core.js';

const NO_POSITION: PositionState = { quantity: 0, avgCost: 0 };

const awaitsTrades = (state: PositionState): PositionState => state;

const EVENT_STEPS = {
  [InvestmentEventType.enum.opening]: (_state, event) => ({ quantity: event.quantity, avgCost: event.unitCost }),
  [InvestmentEventType.enum.buy]: awaitsTrades,
  [InvestmentEventType.enum.sell]: awaitsTrades,
  [InvestmentEventType.enum.split]: awaitsTrades,
} as const satisfies Record<InvestmentEventType, (state: PositionState, event: InvestmentEvent) => PositionState>;

const applyEvent = (state: PositionState, event: InvestmentEvent): PositionState =>
  EVENT_STEPS[event.type](state, event);

export const foldPosition = (events: readonly InvestmentEvent[]): PositionState =>
  R.pipe(
    events,
    R.sortBy((event) => event.date),
    R.reduce(applyEvent, NO_POSITION),
  );

const positionKey = (event: InvestmentEvent): string => JSON.stringify([event.accountId, event.assetId]);

const toPosition = (events: readonly [InvestmentEvent, ...InvestmentEvent[]]): Position => ({
  accountId: events[0].accountId,
  assetId: events[0].assetId,
  ...foldPosition(events),
});

export const isOpening = (event: Pick<InvestmentEvent, 'type'>): boolean =>
  event.type === InvestmentEventType.enum.opening;

const isHeld = (position: Position): boolean => position.quantity > 0;

export const foldPositions = (events: readonly InvestmentEvent[]): Position[] =>
  R.pipe(events, R.groupBy(positionKey), R.values(), R.filter(R.isDefined), R.map(toPosition), R.filter(isHeld));
