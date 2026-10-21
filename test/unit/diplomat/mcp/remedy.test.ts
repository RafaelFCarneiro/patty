import { describe, expect, it } from 'vitest';
import type { Tenancy } from '../../../../src/controllers/deps.js';
import { ownerGate } from '../../../../src/diplomat/mcp/gate.js';
import { remedyHint, withToolHint } from '../../../../src/diplomat/mcp/remedy.js';
import { jsonError } from '../../../../src/diplomat/mcp/respond.js';
import { toolScopesOf } from '../../../../src/diplomat/mcp/scopes.js';
import { buildMcpServer } from '../../../../src/diplomat/mcp/server.js';
import { accountErrors } from '../../../../src/models/account.js';
import { cardErrors } from '../../../../src/models/credit-card.js';
import { Remedy } from '../../../../src/models/remedy.js';
import { transactionErrors } from '../../../../src/models/transaction.js';
import { notFound } from '../../../../src/models/error.js';

const registered = [...toolScopesOf(buildMcpServer({} as Tenancy, '0.0.0-test', { gate: ownerGate })).keys()];

const replyBody = (error: Parameters<typeof jsonError>[0]) =>
  JSON.parse(jsonError(error).content[0]!.text) as { error: Record<string, unknown> };

describe('MCP remedy translation', () => {
  it.each(Remedy.options)('%s maps to a registered tool and reads "use <tool>"', (remedy) => {
    const hint = remedyHint(remedy);
    expect(hint.startsWith('use ')).toBe(true);
    expect(registered).toContain(hint.slice('use '.length));
  });

  it('names the tool that performs the operation', () => {
    expect(remedyHint(Remedy.enum.pay_bill)).toBe('use pay_bill');
    expect(remedyHint(Remedy.enum.update_card_transaction)).toBe('use update_card_transaction');
    expect(remedyHint(Remedy.enum.delete_account_transaction)).toBe('use delete_account_transaction');
  });

  it('replies with a hint instead of the remedy, leaving the neutral message untouched', () => {
    const error = transactionErrors.wrongOperation(Remedy.enum.update_card_transaction);
    const { error: body } = replyBody(error);
    expect(body).toMatchObject({
      code: 'validation',
      hint: 'use update_card_transaction',
      issues: error.code === 'validation' ? error.issues : [],
    });
    expect(body).not.toHaveProperty('remedy');
  });

  it('hints every domain error that carries a remedy', () => {
    expect(replyBody(cardErrors.paidBillImmutable).error.hint).toBe('use revert_bill_payment');
    expect(replyBody(accountErrors.creditTransferFromRejected('Nubank')).error.hint).toBe('use pay_bill');
    expect(replyBody(accountErrors.creditRejected(Remedy.enum.delete_credit_card)).error.hint).toBe(
      'use delete_credit_card',
    );
    expect(replyBody(transactionErrors.confirmEditNotAllowedForTransfer).error.hint).toBe(
      'use update_account_transaction',
    );
  });

  it('leaves an error without a remedy exactly as it was', () => {
    const error = notFound('account', 'Checking', []);
    expect(withToolHint(error)).toBe(error);
  });
});
