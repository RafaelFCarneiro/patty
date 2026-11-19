import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { resolveByName } from '../../logic/resolve.js';
import type { Account } from '../../models/account.js';
import type {
  GetPortfolioInput,
  PortfolioView,
  PositionValuation,
  ValuationContext,
} from '../../models/investment/core.js';
import type { Deps } from '../deps.js';
import { resolutionToResult } from '../resolve.js';
import { loadValuationBasis } from '../valuation.js';
import * as positions from '../../logic/investment/positions.js';
import * as valuation from '../../logic/investment/valuation.js';

export const valueHoldings = async (
  deps: Deps,
  accounts: readonly Pick<Account, 'id' | 'name'>[],
  context: ValuationContext,
): Promise<PositionValuation[]> => {
  const accountIds = new Set(R.map(accounts, (account) => account.id));
  const events = R.filter(await deps.investments.list(), (event) => accountIds.has(event.accountId));
  if (events.length === 0) return [];
  const [assets, prices] = await Promise.all([deps.assets.list(), deps.assetPrices.latest()]);
  return valuation.valueAll(positions.foldAll(events), accounts, assets, prices, context);
};

export const getPortfolio = (deps: Deps, input: GetPortfolioInput): ResultAsync<PortfolioView, AppError> =>
  safeTry(async function* () {
    const everyAccount = await deps.accounts.list();
    const accounts = input.account
      ? [yield* resolutionToResult(resolveByName(everyAccount, input.account), 'account')]
      : everyAccount;
    const { baseCurrency, baseDecimals, context } = await loadValuationBasis(deps);
    const held = await valueHoldings(deps, accounts, context);
    return ok({ baseCurrency, positions: held, ...valuation.consolidate(held, baseCurrency, baseDecimals) });
  });
