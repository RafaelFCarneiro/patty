import { ACCOUNT_ENTITY_TAG } from '../../../src/models/account.js';
import { BILL_ENTITY_TAG } from '../../../src/models/bill.js';
import { BUDGET_ENTITY_TAG } from '../../../src/models/budget.js';
import { CATEGORY_ENTITY_TAG } from '../../../src/models/category.js';
import { CREDIT_CARD_ENTITY_TAG } from '../../../src/models/credit-card.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currency-rate.js';
import { DASHBOARD_ENTITY_TAG } from '../../../src/models/dashboard.js';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { RECURRING_ENTITY_TAG } from '../../../src/models/recurring.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import { TRANSACTION_ENTITY_TAG } from '../../../src/models/transaction.js';

/** Every entity tag a bundled dashboard can listen for: the shell's resync list is checked against it. */
export const DASHBOARD_ENTITY_TAGS: string[] = [
  ACCOUNT_ENTITY_TAG, BILL_ENTITY_TAG, BUDGET_ENTITY_TAG, CATEGORY_ENTITY_TAG, CREDIT_CARD_ENTITY_TAG,
  CURRENCY_RATE_ENTITY_TAG, DASHBOARD_ENTITY_TAG, RECURRING_ENTITY_TAG, TAG_ENTITY_TAG, TRANSACTION_ENTITY_TAG,
  USER_SETTINGS_ENTITY_TAG,
];
