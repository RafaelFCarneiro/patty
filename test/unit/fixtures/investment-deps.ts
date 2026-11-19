import type { ResultAsync } from 'neverthrow';
import type { FlowOutcome, Persistable, PersistOutcome } from '@rfc0/effect-runner';
import type { AppError } from '../../../src/common/errors.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { AccountEntity } from '../../../src/models/account.js';
import type { AssetEntity, AssetPriceEntity } from '../../../src/models/investment/asset.js';
import type { CurrencyRateEntity } from '../../../src/models/currency-rate.js';
import type { AccountActivity, InvestmentEventEntity } from '../../../src/models/investment/core.js';
import { Locale } from '../../../src/models/locale.js';
import { type CurrencyCode } from '../../../src/models/money.js';
import { SEEDED_CURRENCIES } from './currencies.js';
import { NOW } from './investment.js';

/** What the stubbed repos hold: the flows read it through `Deps` and decide, they never write it back. */
export type InvestmentWorld = {
  accounts?: AccountEntity[];
  assets?: AssetEntity[];
  prices?: AssetPriceEntity[];
  events?: InvestmentEventEntity[];
  rates?: CurrencyRateEntity[];
  /** What every account already holds in activity: the transaction count and the movements they add up to. */
  activity?: AccountActivity;
  baseCurrency?: CurrencyCode | null;
  /** The ids handed out by `newId`, in order. */
  ids?: string[];
};

const ZERO_PARTS = { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 };

/** The `list` of a stubbed repo that narrows the way the real one does. */
const eventsMatching =
  (events: InvestmentEventEntity[]): Deps['investments']['list'] =>
  async (filter = {}) =>
    events.filter(
      (event) =>
        (filter.accountId === undefined || event.accountId === filter.accountId) &&
        (filter.assetId === undefined || event.assetId === filter.assetId),
    );

/** A full `Deps` over an in-memory world; every repo the investment flows do not use stays an empty stub. */
export const investmentDeps = (world: InvestmentWorld = {}): Deps => {
  const accounts = world.accounts ?? [];
  const assets = world.assets ?? [];
  const prices = world.prices ?? [];
  const events = world.events ?? [];
  const ids = [...(world.ids ?? [])];
  return {
    accounts: {
      list: async () => accounts,
      findById: async (id: string) => accounts.find((account) => account.id === id) ?? null,
      findRawById: async (id: string) => accounts.find((account) => account.id === id) ?? null,
      balanceParts: async () => world.activity?.movements ?? ZERO_PARTS,
      countReferences: async () => ({
        transactions: world.activity?.transactions ?? 0,
        recurring: 0,
        cards: 0,
        investmentEvents: events.length,
      }),
    } as unknown as Deps['accounts'],
    assets: {
      list: async () => assets,
      findByKey: async (symbol: string, exchange: string) =>
        assets.find((asset) => asset.symbol === symbol && asset.exchange === exchange) ?? null,
    } as Deps['assets'],
    assetPrices: {
      latest: async () => prices,
      findAt: async (assetId: string, asOf: string) =>
        prices.find((price) => price.assetId === assetId && price.asOf === asOf) ?? null,
    } as Deps['assetPrices'],
    investments: {
      list: eventsMatching(events),
      findById: async (id: string) => events.find((event) => event.id === id) ?? null,
    },
    currencies: { list: async () => SEEDED_CURRENCIES } as Deps['currencies'],
    currencyRates: { list: async () => world.rates ?? [] } as unknown as Deps['currencyRates'],
    settings: {
      getLocale: async () => ({
        id: 'singleton',
        locale: Locale.enum.en,
        localeSource: 'default',
        baseCurrency: world.baseCurrency ?? null,
        version: 0,
      }),
    } as unknown as Deps['settings'],
    bills: {} as Deps['bills'],
    budgets: {} as Deps['budgets'],
    categories: {} as Deps['categories'],
    subCategories: {} as Deps['subCategories'],
    correlations: {} as Deps['correlations'],
    creditCards: {} as Deps['creditCards'],
    dashboards: {} as Deps['dashboards'],
    health: {} as Deps['health'],
    instance: {} as Deps['instance'],
    merchants: {} as Deps['merchants'],
    recurring: {} as Deps['recurring'],
    tags: {} as Deps['tags'],
    transactions: {
      pendingBalanceParts: async () => ZERO_PARTS,
    } as unknown as Deps['transactions'],
    clock: () => NOW,
    newId: () => ids.shift() ?? 'generated-id',
    locale: async () => Locale.enum.en,
    rateStaleness: { fiatHours: 24, cryptoHours: 1 },
    priceStaleness: { marketHours: 72, manualDays: 31 },
  };
};

/** The effects and the plain response of a successful flow (none of these flows has an outcome-dependent response). */
export const decided = async <T>(
  flow: ResultAsync<FlowOutcome<T>, AppError>,
): Promise<{ persist: Persistable[]; response: T }> => {
  const { persist, response } = (await flow)._unsafeUnwrap();
  return { persist, response: response as T };
};

export const decidedWith = async <T>(
  flow: ResultAsync<FlowOutcome<T>, AppError>,
  outcomes: PersistOutcome[],
): Promise<{ persist: Persistable[]; response: T }> => {
  const { persist, response } = (await flow)._unsafeUnwrap();
  return {
    persist,
    response: typeof response === 'function' ? (response as (o: PersistOutcome[]) => T)(outcomes) : response,
  };
};
