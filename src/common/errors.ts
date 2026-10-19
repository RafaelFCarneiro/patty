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
import type { Remedy } from '../models/remedy.js';
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

type ErrorOf<C extends AppError['code']> = Extract<AppError, { code: C }>;
type Formatters<C extends AppError['code']> = { [K in C]: (e: ErrorOf<K>) => string };

const withCode = (code: AppError['code'], detail: string): string => `${code}: ${detail}`;

const formatCandidates = (e: { code: AppError['code']; query: string; candidates: string[] }): string =>
  withCode(e.code, `"${e.query}" (candidates: ${e.candidates.join(', ')})`);

const formatHint = (e: { code: AppError['code']; hint: string }): string => withCode(e.code, e.hint);

const formatMessage =
  (message: string) =>
  (e: { code: AppError['code'] }): string =>
    withCode(e.code, message);

const LOOKUP_FORMATTERS = {
  unknown_account: formatCandidates,
  ambiguous_account: formatCandidates,
  unknown_category: formatCandidates,
  ambiguous_category: formatCandidates,
  unknown_sub_category: formatCandidates,
  ambiguous_sub_category: formatCandidates,
  unknown_card: formatCandidates,
  ambiguous_card: formatCandidates,
  unknown_dashboard: formatCandidates,
  unknown_budget: formatCandidates,
};

const DOMAIN_FORMATTERS = {
  validation: (e) => withCode(e.code, e.issues.join(', ')),
  category_kind_mismatch: formatHint,
  duplicate_name: (e) => withCode(e.code, `${e.entity} "${e.name}"`),
  in_use: (e) =>
    e.entity === 'account'
      ? `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, cards: ${e.references.cards})`
      : `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, subCategories: ${e.references.subCategories})`,
  unknown_transaction: (e) => withCode(e.code, e.id),
  unknown_bill: (e) => withCode(e.code, `${e.card} ${e.year}-${String(e.month).padStart(2, '0')}`),
  not_expense_category: (e) => withCode(e.code, `"${e.category}" is not an expense-eligible category`),
  duplicate_budget: (e) =>
    withCode(e.code, `${e.category}${e.subCategory ? `/${e.subCategory}` : ''} (${e.currency}, ${e.period})`),
  conflict: formatMessage('concurrent update, please retry'),
} satisfies Formatters<
  | 'validation'
  | 'category_kind_mismatch'
  | 'duplicate_name'
  | 'in_use'
  | 'unknown_transaction'
  | 'unknown_bill'
  | 'not_expense_category'
  | 'duplicate_budget'
  | 'conflict'
>;

const AUTH_FORMATTERS = {
  unauthenticated: formatMessage(AUTH_MESSAGES.unauthenticated),
  invalid_credentials: formatMessage(AUTH_MESSAGES.invalidCredentials),
  invalid_setup_code: formatMessage(AUTH_MESSAGES.invalidSetupCode),
  setup_unavailable: formatMessage(AUTH_MESSAGES.setupUnavailable),
  unknown_user: (e) => withCode(e.code, `${AUTH_MESSAGES.unknownUser} (${e.username})`),
  owner_unclaimed: formatMessage(AUTH_MESSAGES.ownerUnclaimed),
  rate_limited: formatMessage(AUTH_MESSAGES.rateLimited),
  forbidden_origin: formatHint,
  invalid_token: formatMessage(AUTH_MESSAGES.invalidToken),
  insufficient_scope: (e) => withCode(e.code, `${AUTH_MESSAGES.insufficientScope} (needs ${e.scope})`),
  unknown_token: (e) => withCode(e.code, `${AUTH_MESSAGES.unknownToken} (${e.id})`),
  resource_metadata_unavailable: formatHint,
  session_required: formatMessage(AUTH_MESSAGES.sessionRequired),
  invalid_grant: formatMessage(AUTH_MESSAGES.invalidGrant),
  admin_required: formatMessage(AUTH_MESSAGES.adminRequired),
  username_taken: (e) => withCode(e.code, `${AUTH_MESSAGES.usernameTaken} (${e.username})`),
  cannot_change_self: formatMessage(AUTH_MESSAGES.cannotChangeSelf),
  last_admin: formatMessage(AUTH_MESSAGES.lastAdmin),
  invalid_invite: formatMessage(AUTH_MESSAGES.invalidInvite),
  user_disabled: formatMessage(AUTH_MESSAGES.userDisabled),
} satisfies Formatters<AuthError['code']>;

const FORMATTERS: Formatters<AppError['code']> = {
  ...LOOKUP_FORMATTERS,
  ...DOMAIN_FORMATTERS,
  ...AUTH_FORMATTERS,
};

export const formatAppError = (e: AppError): string => (FORMATTERS[e.code] as (e: AppError) => string)(e);

const STATUS = {
  notFound: 404,
  unauthorized: 401,
  forbidden: 403,
  tooManyRequests: 429,
  conflict: 409,
  unprocessable: 422,
} as const;

const HTTP_STATUS = {
  unknown_account: STATUS.notFound,
  unknown_category: STATUS.notFound,
  unknown_sub_category: STATUS.notFound,
  unknown_card: STATUS.notFound,
  unknown_transaction: STATUS.notFound,
  unknown_bill: STATUS.notFound,
  unknown_dashboard: STATUS.notFound,
  unknown_budget: STATUS.notFound,
  unknown_token: STATUS.notFound,
  unknown_user: STATUS.notFound,
  invalid_grant: STATUS.notFound,
  admin_required: STATUS.notFound,
  resource_metadata_unavailable: STATUS.notFound,
  unauthenticated: STATUS.unauthorized,
  invalid_credentials: STATUS.unauthorized,
  invalid_token: STATUS.unauthorized,
  invalid_setup_code: STATUS.forbidden,
  invalid_invite: STATUS.forbidden,
  forbidden_origin: STATUS.forbidden,
  insufficient_scope: STATUS.forbidden,
  session_required: STATUS.forbidden,
  rate_limited: STATUS.tooManyRequests,
  ambiguous_account: STATUS.conflict,
  ambiguous_category: STATUS.conflict,
  ambiguous_sub_category: STATUS.conflict,
  ambiguous_card: STATUS.conflict,
  duplicate_name: STATUS.conflict,
  duplicate_budget: STATUS.conflict,
  in_use: STATUS.conflict,
  conflict: STATUS.conflict,
  setup_unavailable: STATUS.conflict,
  username_taken: STATUS.conflict,
  cannot_change_self: STATUS.conflict,
  last_admin: STATUS.conflict,
  user_disabled: STATUS.conflict,
  owner_unclaimed: STATUS.conflict,
  category_kind_mismatch: STATUS.unprocessable,
  not_expense_category: STATUS.unprocessable,
  validation: STATUS.unprocessable,
} as const satisfies Record<AppError['code'], number>;

export const httpStatus = (e: AppError): number => HTTP_STATUS[e.code];

/** An error as an edge shows it: a remedy replaced by the edge's own `hint`; every other error untouched. */
type WithoutRemedy<E> = E extends unknown ? Omit<E, 'remedy'> : never;
export type HintedError = WithoutRemedy<AppError> & { hint?: string };

/**
 * Where an error's `remedy` (a domain operation) becomes words: each edge passes the function that names that
 * operation in its own vocabulary, so the domain never has to.
 */
export const withRemedyHint = (error: AppError, hintFor: (remedy: Remedy) => string): HintedError => {
  if (!('remedy' in error) || error.remedy === undefined) return error;
  const { remedy, ...rest } = error;
  return { ...rest, hint: hintFor(remedy) };
};
