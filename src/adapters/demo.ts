import * as R from 'remeda';
import type { FlowOutcome } from '@rfc0/effect-runner';
import * as accountAdapters from './accounts.js';
import * as billAdapters from './bills.js';
import * as budgetAdapters from './budgets.js';
import * as creditCardAdapters from './credit-cards.js';
import * as currencyRateAdapters from './currency-rates.js';
import * as recurringAdapters from './recurring.js';
import * as settingsAdapters from './settings.js';
import * as tagAdapters from './tags.js';
import * as transactionAdapters from './transactions.js';

/** The demo seeder runs one flow after another through one runner; each adapter only rewrites its own entity's tag, so
 *  applying them all in turn adapts whichever flow just ran (docs/write-path.md § From model to row). */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> =>
  R.pipe(
    outcome,
    settingsAdapters.outcomeToDb,
    accountAdapters.outcomeToDb,
    creditCardAdapters.outcomeToDb,
    billAdapters.outcomeToDb,
    budgetAdapters.outcomeToDb,
    currencyRateAdapters.outcomeToDb,
    recurringAdapters.outcomeToDb,
    tagAdapters.outcomeToDb,
    transactionAdapters.outcomeToDb,
  );
