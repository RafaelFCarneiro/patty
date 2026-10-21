import { describe, expect, it } from 'vitest';
import { documentationContext } from '../../../../src/diplomat/http/context.js';
import { remedyHint, remedyRoute, withRouteHint } from '../../../../src/diplomat/http/remedy.js';
import { buildRouteDefinitions } from '../../../../src/diplomat/http/routes.js';
import { accountErrors } from '../../../../src/models/account.js';
import { cardErrors } from '../../../../src/models/credit-card.js';
import { notFound } from '../../../../src/models/error.js';
import { Remedy } from '../../../../src/models/remedy.js';
import { transactionErrors } from '../../../../src/models/transaction.js';

const routes = buildRouteDefinitions(documentationContext('0.0.0-test'));

describe('REST remedy translation', () => {
  it.each(Remedy.options)('%s maps to a route that is actually defined', (remedy) => {
    const [method, path] = remedyRoute(remedy).split(' ') as [string, string];
    expect(routes.some((route) => route.method.toUpperCase() === method && route.path === path)).toBe(true);
  });

  it('names the route that performs the operation', () => {
    expect(remedyHint(Remedy.enum.pay_bill)).toBe('use POST /api/bills/pay');
    expect(remedyHint(Remedy.enum.update_card_transaction)).toBe('use PATCH /api/credit-cards/transactions/:id');
    expect(remedyHint(Remedy.enum.delete_account_transaction)).toBe('use DELETE /api/accounts/transactions/:id');
  });

  it('replaces the remedy with a hint on the error body, leaving the neutral message untouched', () => {
    const error = transactionErrors.wrongOperation(Remedy.enum.delete_card_transaction);
    const body = withRouteHint(error);
    expect(body).toMatchObject({ code: 'validation', hint: 'use DELETE /api/credit-cards/transactions/:id' });
    expect(body).not.toHaveProperty('remedy');
    expect(body).toHaveProperty('issues', error.code === 'validation' ? error.issues : undefined);
  });

  it('hints every domain error that carries a remedy', () => {
    expect(withRouteHint(cardErrors.paidBillImmutable)).toMatchObject({ hint: 'use POST /api/bills/revert' });
    expect(withRouteHint(accountErrors.creditTransferToRejected('Nubank'))).toMatchObject({
      hint: 'use POST /api/bills/pay',
    });
    expect(withRouteHint(accountErrors.creditRejected(Remedy.enum.create_credit_card))).toMatchObject({
      hint: 'use POST /api/credit-cards',
    });
  });

  it('leaves an error without a remedy exactly as it was', () => {
    const error = notFound('account', 'Checking', []);
    expect(withRouteHint(error)).toBe(error);
  });
});
