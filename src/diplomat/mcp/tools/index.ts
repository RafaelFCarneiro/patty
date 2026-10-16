import type { ToolDefinition } from '../definition.js';
import { accountTools } from './account.js';
import { aggregateTools } from './aggregate.js';
import { budgetTools } from './budget.js';
import { categoryTools } from './category.js';
import { correlationsTools } from './correlations.js';
import { creditCardTools } from './creditCard.js';
import { currencyRateTools } from './currencyRates.js';
import { dashboardTools } from './dashboard.js';
import { recurringTools } from './recurring.js';
import { summaryTools } from './summary.js';
import { systemTools } from './system.js';
import { tagTools } from './tag.js';
import { transactionTools } from './transaction.js';
import { transferTools } from './transfer.js';

/** Every tool, in registration (and `tools/list`) order — a new domain module's list is added here and nowhere else. */
export const toolDefinitions: readonly ToolDefinition[] = [
  ...accountTools,
  ...creditCardTools,
  ...currencyRateTools,
  ...transactionTools,
  ...transferTools,
  ...budgetTools,
  ...recurringTools,
  ...categoryTools,
  ...tagTools,
  ...dashboardTools,
  ...correlationsTools,
  ...aggregateTools,
  ...summaryTools,
  ...systemTools,
];
