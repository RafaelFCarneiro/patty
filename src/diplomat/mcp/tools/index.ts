import type { ToolDefinition } from '../definition.js';
import { accountTools } from './account.js';
import { aggregateTools } from './aggregate.js';
import { budgetTools } from './budget.js';
import { categoryTools } from './category.js';
import { correlationsTools } from './correlations.js';
import { creditCardTools } from './credit-card.js';
import { currencyTools } from './currency.js';
import { currencyRateTools } from './currency-rates.js';
import { dashboardTools } from './dashboard.js';
import { investmentTools } from './investment.js';
import { merchantTools } from './merchant.js';
import { recurringTools } from './recurring.js';
import { referenceTools } from './reference.js';
import { summaryTools } from './summary.js';
import { systemTools } from './system.js';
import { tagTools } from './tag.js';
import { transactionTools } from './transaction.js';
import { transferTools } from './transfer.js';

/** Every tool, in registration (and `tools/list`) order — a new domain module's list is added here and nowhere else. */
export const toolDefinitions: readonly ToolDefinition[] = [
  ...accountTools,
  ...creditCardTools,
  ...currencyTools,
  ...currencyRateTools,
  ...investmentTools,
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
  ...merchantTools,
  ...referenceTools,
  ...systemTools,
];
