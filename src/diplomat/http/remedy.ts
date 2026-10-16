import { withRemedyHint, type AppError } from '../../common/errors.js';
import type { Remedy } from '../../models/remedy.js';
import type { HttpMethod } from './openapi.js';

/**
 * The route that performs each domain operation a rejected call is told to use instead. The route definitions take
 * their method and path from here (`...REMEDY_ROUTE.pay_bill`), so each path is typed once and a hint can never drift
 * from the route it names. A leaf module (type imports only): `respond.ts` needs it, and the route modules need
 * `respond.ts`.
 */
export const REMEDY_ROUTE = {
  pay_bill: { method: 'post', path: '/api/bills/pay' },
  revert_bill_payment: { method: 'post', path: '/api/bills/revert' },
  create_credit_card: { method: 'post', path: '/api/credit-cards' },
  update_credit_card: { method: 'patch', path: '/api/credit-cards/:name' },
  delete_credit_card: { method: 'delete', path: '/api/credit-cards/:name' },
  update_account_transaction: { method: 'patch', path: '/api/accounts/transactions/:id' },
  update_card_transaction: { method: 'patch', path: '/api/credit-cards/transactions/:id' },
  delete_account_transaction: { method: 'delete', path: '/api/accounts/transactions/:id' },
  delete_card_transaction: { method: 'delete', path: '/api/credit-cards/transactions/:id' },
} as const satisfies Record<Remedy, { method: HttpMethod; path: string }>;

/** `"METHOD /path"` of the route that performs the remedy. */
export const remedyRoute = (remedy: Remedy): string => {
  const { method, path } = REMEDY_ROUTE[remedy];
  return `${method.toUpperCase()} ${path}`;
};

export const remedyHint = (remedy: Remedy): string => `use ${remedyRoute(remedy)}`;

/** The error as a REST reply shows it: a `remedy` becomes `hint: "use <METHOD /route>"`. */
export const withRouteHint = (error: AppError) => withRemedyHint(error, remedyHint);
