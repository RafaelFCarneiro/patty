import { describe, expect, it } from 'vitest';
import { PersistOp } from '@rfc0/effect-runner';
import {
  deleteInvestmentEvent,
  listInvestmentEvents,
  openPosition,
  updateInvestmentEvent,
} from '../../../../src/controllers/investment/events.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type AccountEntity } from '../../../../src/models/account.js';
import type { AssetEntity } from '../../../../src/models/investment/asset.js';
import {
  INVESTMENT_EVENT_ENTITY_TAG,
  InvestmentEventType,
  OpenPositionSchema,
  UpdateInvestmentEventSchema,
  investmentErrors,
  type InvestmentEventEntity,
} from '../../../../src/models/investment/core.js';
import { decided, investmentDeps } from '../../fixtures/investment-deps.js';
import { investmentAccount, kncrAsset, NOW, nuAsset, openingEvent, priceOf } from '../../fixtures/investment.js';
import * as idempotency from '../../../../src/logic/investment/idempotency.js';

const account = (overrides: Partial<AccountEntity> = {}): AccountEntity => ({
  ...investmentAccount(),
  version: 3,
  ...overrides,
});
const asset = (overrides: Partial<AssetEntity> = {}): AssetEntity => ({ ...nuAsset(), version: 1, ...overrides });
const eventEntity = (overrides: Partial<InvestmentEventEntity> = {}): InvestmentEventEntity => ({
  ...openingEvent(),
  version: 5,
  ...overrides,
});

const OPEN = { account: 'Nu Holdings (NYSE:NU)', asset: 'NU', quantity: 10, avgCost: 8 };

describe('openPosition', () => {
  const world = { accounts: [account({ initialBalance: 500 })], assets: [asset()], ids: ['event-new'] };

  it('writes the account’s remaining cash and the opening event in ONE batch, the cash first', async () => {
    const { persist, response } = await decided(openPosition(investmentDeps(world), { ...OPEN, remainingCash: 85 }));
    expect(persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: ACCOUNT_ENTITY_TAG,
        model: { ...investmentAccount(), initialBalance: 85, version: 3 },
      },
      {
        op: PersistOp.enum.insert,
        entity: INVESTMENT_EVENT_ENTITY_TAG,
        model: {
          id: 'event-new',
          accountId: 'acc-inv',
          assetId: 'asset-nu',
          type: 'opening',
          date: '2026-11-18',
          quantity: 10,
          unitCost: 8,
          note: null,
          replacedCash: 500,
        },
        idempotencyKey: idempotency.deriveKey(
          { accountId: 'acc-inv', assetId: 'asset-nu', type: 'opening', date: '2026-11-18', quantity: 10, unitCost: 8 },
          2,
        ),
      },
    ]);
    expect(response).toEqual({
      id: 'event-new',
      account: 'Nu Holdings (NYSE:NU)',
      asset: 'NYSE:NU',
      type: 'opening',
      date: '2026-11-18',
      quantity: 10,
      avgCost: 8,
      note: null,
      replacedCash: 500,
      costBasis: 80,
      warnings: [],
    });
  });

  it('sets the account cash to 0 by default, so the old static value is never counted with the holding', async () => {
    const { persist } = await decided(openPosition(investmentDeps(world), OPEN));
    expect(persist[0]).toMatchObject({ entity: ACCOUNT_ENTITY_TAG, model: { initialBalance: 0 } });
  });

  it('does not rewrite an account that is already at that cash', async () => {
    const deps = investmentDeps({ ...world, accounts: [account({ initialBalance: 0 })] });
    const { persist } = await decided(openPosition(deps, OPEN));
    expect(persist.map((p) => p.entity)).toEqual([INVESTMENT_EVENT_ENTITY_TAG]);
  });

  it('defaults the average cost to the latest price and says so in a warning', async () => {
    const deps = investmentDeps({
      ...world,
      prices: [{ ...priceOf(nuAsset(), 13.2, '2026-11-18T12:00:00.000Z'), version: 0 }],
    });
    const { persist, response } = await decided(
      openPosition(deps, { account: OPEN.account, asset: 'NU', quantity: 10 }),
    );
    expect(persist[1]).toMatchObject({ model: { unitCost: 13.2 } });
    expect(response.warnings).toHaveLength(1);
    expect(response.warnings[0]).toContain('P&L for NYSE:NU starts at the latest price (13.2');
  });

  it('is refused with no average cost and no price, writing nothing', async () => {
    const result = await openPosition(investmentDeps(world), { account: OPEN.account, asset: 'NU', quantity: 10 });
    expect(result._unsafeUnwrapErr()).toEqual(investmentErrors.noPriceNoCost('NYSE:NU'));
  });

  it('is refused on an account that is not an investment account', async () => {
    const deps = investmentDeps({ ...world, accounts: [account({ type: AccountType.enum.checking })] });
    expect((await openPosition(deps, OPEN))._unsafeUnwrapErr()).toEqual(
      investmentErrors.notInvestmentAccount('Nu Holdings (NYSE:NU)', 'checking'),
    );
  });

  it('treats another user’s account as one that does not exist (the repo only lists the caller’s)', async () => {
    const deps = investmentDeps({ ...world, accounts: [] });
    expect((await openPosition(deps, OPEN))._unsafeUnwrapErr()).toMatchObject({ code: 'unknown_account' });
  });

  it('is refused for an unknown asset, listing the registered ones', async () => {
    expect((await openPosition(investmentDeps(world), { ...OPEN, asset: 'ZZZ' }))._unsafeUnwrapErr()).toEqual({
      code: 'unknown_asset',
      query: 'ZZZ',
      candidates: ['NYSE:NU'],
    });
  });

  it('is refused for a second opening of the same account and asset: edit the first instead', async () => {
    const deps = investmentDeps({ ...world, events: [eventEntity()] });
    expect((await openPosition(deps, OPEN))._unsafeUnwrapErr()).toEqual(
      investmentErrors.openingExists('Nu Holdings (NYSE:NU)', 'NYSE:NU'),
    );
  });

  it('still allows an opening of another asset in the same account', async () => {
    const deps = investmentDeps({
      ...world,
      assets: [asset(), asset(kncrAsset())],
      events: [eventEntity()],
    });
    expect((await openPosition(deps, { ...OPEN, asset: 'KNCR11' })).isOk()).toBe(true);
  });

  it('refuses a quantity of zero or less at the boundary, before the flow runs', () => {
    expect(OpenPositionSchema.safeParse({ ...OPEN, quantity: 0 }).success).toBe(false);
    expect(OpenPositionSchema.safeParse({ ...OPEN, quantity: -1 }).success).toBe(false);
    expect(OpenPositionSchema.safeParse({ ...OPEN, avgCost: -1 }).success).toBe(false);
    expect(OpenPositionSchema.safeParse({ ...OPEN, remainingCash: -1 }).success).toBe(false);
    expect(OpenPositionSchema.safeParse(OPEN).success).toBe(true);
  });

  it('uses the given date, not today', async () => {
    const { persist } = await decided(openPosition(investmentDeps(world), { ...OPEN, date: '2026-10-05' }));
    expect(persist[1]).toMatchObject({ model: { date: '2026-10-05' } });
    expect(NOW.toISOString().slice(0, 10)).toBe('2026-11-18');
  });
});

describe('no flow accepts buy, sell or split yet', () => {
  it('open_position records an opening whatever it is asked, and has no field to ask for another type', async () => {
    expect(Object.keys(OpenPositionSchema.shape)).not.toContain('type');
    const { persist } = await decided(
      openPosition(investmentDeps({ accounts: [account()], assets: [asset()], ids: ['event-new'] }), OPEN),
    );
    const event = persist.find((p) => p.entity === INVESTMENT_EVENT_ENTITY_TAG);
    expect(event).toMatchObject({ model: { type: InvestmentEventType.enum.opening } });
  });

  it('an update has no field to change the type', () => {
    expect(Object.keys(UpdateInvestmentEventSchema.shape)).not.toContain('type');
  });
});

describe('listInvestmentEvents', () => {
  const deps = investmentDeps({
    accounts: [account()],
    assets: [asset(), asset(kncrAsset())],
    events: [eventEntity(), eventEntity({ id: 'event-2', assetId: 'asset-kncr', quantity: 4 })],
  });

  it('shows every event with its account name and asset label', async () => {
    const events = (await listInvestmentEvents(deps, {}))._unsafeUnwrap();
    expect(events.map((e) => [e.id, e.account, e.asset, e.quantity])).toEqual([
      ['event-1', 'Nu Holdings (NYSE:NU)', 'NYSE:NU', 10],
      ['event-2', 'Nu Holdings (NYSE:NU)', 'B3:KNCR11', 4],
    ]);
  });

  it('narrows to one account and/or asset', async () => {
    expect((await listInvestmentEvents(deps, { asset: 'KNCR11' }))._unsafeUnwrap().map((e) => e.id)).toEqual([
      'event-2',
    ]);
    expect(
      (await listInvestmentEvents(deps, { account: 'Nu Holdings (NYSE:NU)', asset: 'NU' }))._unsafeUnwrap(),
    ).toHaveLength(1);
  });

  it('refuses an unknown account or asset by name', async () => {
    expect((await listInvestmentEvents(deps, { account: 'Nope' }))._unsafeUnwrapErr()).toMatchObject({
      code: 'unknown_account',
    });
    expect((await listInvestmentEvents(deps, { asset: 'ZZZ' }))._unsafeUnwrapErr()).toMatchObject({
      code: 'unknown_asset',
    });
  });
});

describe('updateInvestmentEvent', () => {
  const deps = investmentDeps({ accounts: [account()], assets: [asset()], events: [eventEntity()] });

  it('emits a version-guarded update of only the fields given, and answers with the new view', async () => {
    const { persist, response } = await decided(
      updateInvestmentEvent(deps, { id: 'event-1', quantity: 12, avgCost: 9 }),
    );
    expect(persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: INVESTMENT_EVENT_ENTITY_TAG,
        model: { ...eventEntity(), quantity: 12, unitCost: 9 },
      },
    ]);
    expect(response).toMatchObject({ id: 'event-1', quantity: 12, avgCost: 9, asset: 'NYSE:NU' });
  });

  it('writes nothing for a patch that changes nothing', async () => {
    expect((await decided(updateInvestmentEvent(deps, { id: 'event-1', quantity: 10 }))).persist).toEqual([]);
  });

  it('refuses an id that is not the caller’s or does not exist', async () => {
    expect((await updateInvestmentEvent(deps, { id: 'nope', quantity: 1 }))._unsafeUnwrapErr()).toEqual(
      investmentErrors.unknownEvent('nope'),
    );
  });
});

describe('deleteInvestmentEvent', () => {
  const deps = investmentDeps({ accounts: [account({ initialBalance: 85 })], events: [eventEntity()] });

  it('emits a version-guarded remove; an opening that replaced nothing restores nothing', async () => {
    const { persist, response } = await decided(deleteInvestmentEvent(deps, { id: 'event-1' }));
    expect(persist).toEqual([
      { op: PersistOp.enum.delete, entity: INVESTMENT_EVENT_ENTITY_TAG, id: 'event-1', version: 5 },
    ]);
    expect(response).toEqual({ deleted: true });
  });

  it('gives back the cash an opening replaced, in the same batch: the account update, then the removal', async () => {
    const withCash = investmentDeps({
      accounts: [account({ initialBalance: 85, version: 7 })],
      events: [eventEntity({ replacedCash: 500 })],
    });
    const { persist, response } = await decided(deleteInvestmentEvent(withCash, { id: 'event-1' }));
    expect(persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: ACCOUNT_ENTITY_TAG,
        model: { ...investmentAccount(), initialBalance: 500, version: 7 },
      },
      { op: PersistOp.enum.delete, entity: INVESTMENT_EVENT_ENTITY_TAG, id: 'event-1', version: 5 },
    ]);
    expect(response).toEqual({
      deleted: true,
      restoredCash: { account: 'Nu Holdings (NYSE:NU)', initialBalance: 500 },
    });
  });

  it('restores a replaced cash of 0 too', async () => {
    const zero = investmentDeps({
      accounts: [account({ initialBalance: 85 })],
      events: [eventEntity({ replacedCash: 0 })],
    });
    const { persist, response } = await decided(deleteInvestmentEvent(zero, { id: 'event-1' }));
    expect(persist[0]).toMatchObject({ entity: ACCOUNT_ENTITY_TAG, model: { initialBalance: 0 } });
    expect(response.restoredCash?.initialBalance).toBe(0);
  });

  it('leaves the account alone when the event is not an opening, whatever cash it holds', async () => {
    const other = investmentDeps({
      accounts: [account()],
      events: [eventEntity({ type: InvestmentEventType.enum.buy, replacedCash: 500 })],
    });
    const { persist, response } = await decided(deleteInvestmentEvent(other, { id: 'event-1' }));
    expect(persist.map((p) => p.entity)).toEqual([INVESTMENT_EVENT_ENTITY_TAG]);
    expect(response).toEqual({ deleted: true });
  });

  it('is idempotent: an id that is not the caller’s deletes nothing and restores nothing', async () => {
    const { persist, response } = await decided(deleteInvestmentEvent(deps, { id: 'someone-elses' }));
    expect(persist).toEqual([]);
    expect(response).toEqual({ deleted: false });
  });
});
