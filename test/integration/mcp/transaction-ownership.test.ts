import { afterEach, describe, expect, it } from 'vitest';
import { callTool, callToolError, deleteTransactions, ensure, makeClient } from './helpers.js';

// ADR-017: every update/delete tool self-validates ownership instead of being dispatched to by a
// composition-root router. Calling the wrong tool for a transaction's owning aggregate is rejected
// with a validation error naming the correct tool — a guard, not a redirect the server performs for
// the caller. Ownership is now resolved by account type (ADR-020) rather than cardId/billId
// field-presence; these outcomes are unchanged end-to-end, which this test exercises for real.
describe('MCP integration > transaction ownership guard (ADR-017/ADR-020)', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('rejects update_account_transaction on a card-owned tx, redirects to update_card_transaction', async () => {
    const stamp = Date.now();
    const cardName = `Ownership Card ${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });
      const purchase = (await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Ownership purchase ${stamp}`,
          amount: 30,
          type: 'expense',
          card: cardName,
        },
      })) as { transaction?: { id?: string } };
      ensure(purchase.transaction?.id, 'expected a created transaction');
      createdTxIds.push(purchase.transaction.id);

      const err = (await callToolError(client, {
        name: 'update_account_transaction',
        args: { id: purchase.transaction.id, description: 'Should be rejected' },
      })) as { error?: { code?: string; issues?: string[]; hint?: string } };
      expect(err.error?.code).toBe('validation');
      expect(err.error?.hint).toBe('use update_card_transaction');
    } finally {
      await transport.close();
    }
  });

  it('rejects update_card_transaction on an account-owned tx, redirects to update_account_transaction', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Ownership expense ${stamp}`,
          amount: 15,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      ensure(created.transaction?.id, 'expected a created transaction');
      createdTxIds.push(created.transaction.id);

      const err = (await callToolError(client, {
        name: 'update_card_transaction',
        args: { id: created.transaction.id, description: 'Should be rejected' },
      })) as { error?: { code?: string; issues?: string[]; hint?: string } };
      expect(err.error?.code).toBe('validation');
      expect(err.error?.hint).toBe('use update_account_transaction');
    } finally {
      await transport.close();
    }
  });

  it('rejects delete_account_transaction on a card-owned tx, redirects to delete_card_transaction', async () => {
    const stamp = Date.now();
    const cardName = `OwnershipDelete Card ${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });
      const purchase = (await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `OwnershipDelete purchase ${stamp}`,
          amount: 25,
          type: 'expense',
          card: cardName,
        },
      })) as { transaction?: { id?: string } };
      ensure(purchase.transaction?.id, 'expected a created transaction');
      createdTxIds.push(purchase.transaction.id);

      const err = (await callToolError(client, {
        name: 'delete_account_transaction',
        args: { id: purchase.transaction.id, confirm: true },
      })) as { error?: { code?: string; issues?: string[]; hint?: string } };
      expect(err.error?.code).toBe('validation');
      expect(err.error?.hint).toBe('use delete_card_transaction');
    } finally {
      await transport.close();
    }
  });

  it('rejects delete_card_transaction on an account-owned tx, redirects to delete_account_transaction', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `OwnershipDelete expense ${stamp}`,
          amount: 12,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      ensure(created.transaction?.id, 'expected a created transaction');
      createdTxIds.push(created.transaction.id);

      const err = (await callToolError(client, {
        name: 'delete_card_transaction',
        args: { id: created.transaction.id, confirm: true },
      })) as { error?: { code?: string; issues?: string[]; hint?: string } };
      expect(err.error?.code).toBe('validation');
      expect(err.error?.hint).toBe('use delete_account_transaction');
    } finally {
      await transport.close();
    }
  });
});
