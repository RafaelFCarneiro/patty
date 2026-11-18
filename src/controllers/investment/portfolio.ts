import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { consolidatePortfolio, foldPositions, valuePositions, type ValuationContext } from '../../logic/investment.js';
import { resolveByName } from '../../logic/resolve.js';
import type { Account } from '../../models/account.js';
import type { GetPortfolioInput, PortfolioView, PositionValuation } from '../../models/investment.js';
import type { Deps } from '../deps.js';
import { resolutionToResult } from '../resolve.js';
import { loadValuationBasis } from '../valuation.js';

/** Values the positions of the listed accounts at today's prices and rates (ADR-038 §4). Correlating events, assets,
 *  prices and rates crosses aggregates, so each repo answers for its own table and the pure fold and valuation
 *  correlate them here (ADR-028). An account with no events costs one read; nothing else is fetched. */
export const valueHoldings = async (
  deps: Deps,
  accounts: readonly Pick<Account, 'id' | 'name'>[],
  context: ValuationContext,
): Promise<PositionValuation[]> => {
  const accountIds = new Set(R.map(accounts, (account) => account.id));
  const events = R.filter(await deps.investments.list(), (event) => accountIds.has(event.accountId));
  if (events.length === 0) return [];
  const [assets, prices] = await Promise.all([deps.assets.list(), deps.assetPrices.latest()]);
  return valuePositions(foldPositions(events), accounts, assets, prices, context);
};

export const getPortfolio = (deps: Deps, input: GetPortfolioInput): ResultAsync<PortfolioView, AppError> =>
  safeTry(async function* () {
    const everyAccount = await deps.accounts.list();
    const accounts = input.account
      ? [yield* resolutionToResult(resolveByName(everyAccount, input.account), 'account')]
      : everyAccount;
    const { baseCurrency, baseDecimals, context } = await loadValuationBasis(deps);
    const positions = await valueHoldings(deps, accounts, context);
    return ok({ baseCurrency, positions, ...consolidatePortfolio(positions, baseCurrency, baseDecimals) });
  });
