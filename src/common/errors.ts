import { type AuthError } from '../models/auth/errors.js';
import { AUTH_MESSAGES } from '../models/auth/message.js';
import type { AccountError } from '../models/account.js';
import type { BillError } from '../models/bill.js';
import type { BudgetError } from '../models/budget.js';
import type { CategoryError } from '../models/category.js';
import type { CardError } from '../models/creditCard.js';
import type { CurrencyRateError } from '../models/currencyRate.js';
import type { DashboardError } from '../models/dashboard.js';
import type { Conflict } from '../models/error.js';
import type { LocaleError } from '../models/locale.js';
import type { TagError } from '../models/tag.js';
import type { TransactionError } from '../models/transaction.js';

/** Expected domain failures, returned as `err(AppError)` from controllers. */
export type AppError =
  | AccountError
  | CategoryError
  | CardError
  | TransactionError
  | BillError
  | BudgetError
  | TagError
  | LocaleError
  | CurrencyRateError
  | DashboardError
  | AuthError
  | Conflict;

export const formatAppError = (e: AppError): string => {
  switch (e.code) {
    case 'unknown_account':
    case 'ambiguous_account':
    case 'unknown_category':
    case 'ambiguous_category':
    case 'unknown_sub_category':
    case 'ambiguous_sub_category':
    case 'unknown_card':
    case 'ambiguous_card':
    case 'unknown_dashboard':
    case 'unknown_budget':
      return `${e.code}: "${e.query}" (candidates: ${e.candidates.join(', ')})`;
    case 'validation':
      return `${e.code}: ${e.issues.join(', ')}`;
    case 'category_kind_mismatch':
      return `${e.code}: ${e.hint}`;
    case 'duplicate_name':
      return `${e.code}: ${e.entity} "${e.name}"`;
    case 'in_use':
      return e.entity === 'account'
        ? `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, cards: ${e.references.cards})`
        : `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, subCategories: ${e.references.subCategories})`;
    case 'unknown_transaction':
      return `${e.code}: ${e.id}`;
    case 'unknown_bill':
      return `${e.code}: ${e.card} ${e.year}-${String(e.month).padStart(2, '0')}`;
    case 'not_expense_category':
      return `${e.code}: "${e.category}" is not an expense-eligible category`;
    case 'duplicate_budget':
      return `${e.code}: ${e.category}${e.subCategory ? `/${e.subCategory}` : ''} (${e.currency}, ${e.period})`;
    case 'conflict':
      return `${e.code}: concurrent update, please retry`;
    case 'unauthenticated':
      return `${e.code}: ${AUTH_MESSAGES.unauthenticated}`;
    case 'invalid_credentials':
      return `${e.code}: ${AUTH_MESSAGES.invalidCredentials}`;
    case 'invalid_setup_code':
      return `${e.code}: ${AUTH_MESSAGES.invalidSetupCode}`;
    case 'setup_unavailable':
      return `${e.code}: ${AUTH_MESSAGES.setupUnavailable}`;
    case 'unknown_user':
      return `${e.code}: ${AUTH_MESSAGES.unknownUser} (${e.username})`;
    case 'owner_unclaimed':
      return `${e.code}: ${AUTH_MESSAGES.ownerUnclaimed}`;
    case 'rate_limited':
      return `${e.code}: ${AUTH_MESSAGES.rateLimited}`;
    case 'forbidden_origin':
      return `${e.code}: ${e.hint}`;
    case 'invalid_token':
      return `${e.code}: ${AUTH_MESSAGES.invalidToken}`;
    case 'insufficient_scope':
      return `${e.code}: ${AUTH_MESSAGES.insufficientScope} (needs ${e.scope})`;
    case 'unknown_token':
      return `${e.code}: ${AUTH_MESSAGES.unknownToken} (${e.id})`;
    case 'resource_metadata_unavailable':
      return `${e.code}: ${e.hint}`;
    case 'session_required':
      return `${e.code}: ${AUTH_MESSAGES.sessionRequired}`;
    case 'invalid_grant':
      return `${e.code}: ${AUTH_MESSAGES.invalidGrant}`;
    default: {
      const _exhaustive: never = e;
      throw new Error(`unmapped error code: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

export const httpStatus = (e: AppError): number => {
  switch (e.code) {
    case 'unknown_account':
    case 'unknown_category':
    case 'unknown_sub_category':
    case 'unknown_card':
    case 'unknown_transaction':
    case 'unknown_bill':
    case 'unknown_dashboard':
    case 'unknown_budget':
    case 'unknown_token':
    case 'unknown_user':
    case 'invalid_grant':
    case 'resource_metadata_unavailable':
      return 404;
    case 'unauthenticated':
    case 'invalid_credentials':
    case 'invalid_token':
      return 401;
    case 'invalid_setup_code':
    case 'forbidden_origin':
    case 'insufficient_scope':
    case 'session_required':
      return 403;
    case 'rate_limited':
      return 429;
    case 'ambiguous_account':
    case 'ambiguous_category':
    case 'ambiguous_sub_category':
    case 'ambiguous_card':
    case 'duplicate_name':
    case 'duplicate_budget':
    case 'in_use':
    case 'conflict':
    case 'setup_unavailable':
    case 'owner_unclaimed':
      return 409;
    case 'category_kind_mismatch':
    case 'not_expense_category':
      return 422;
    case 'validation':
      return 422;
    default: {
      const _exhaustive: never = e;
      throw new Error(`unmapped error code: ${JSON.stringify(_exhaustive)}`);
    }
  }
};
