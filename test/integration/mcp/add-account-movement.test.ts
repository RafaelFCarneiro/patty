import { describe, expect, it } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, ensure, makeClient } from './helpers.js';

describe('MCP integration > add_account_expense / add_account_income (ADR-016 step 3)', () => {
  const stamp = Date.now();
  const today = toIsoDate(new Date());

  it('add_account_expense records an expense against the account', async () => {
    const accountName = `AddExpense Account ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 100 },
      });

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Groceries ${stamp}`,
          amount: 25,
          date: today,
          account: accountName,
          idempotencyKey: `add-account-expense-${stamp}`,
        },
      })) as { transaction?: { type?: string; accountName?: string; currency?: string } };

      expect(created.transaction?.type).toBe('expense');
      expect(created.transaction?.accountName).toBe(accountName);
      expect(created.transaction?.currency).toBe('BRL');
    } finally {
      await transport.close();
    }
  });

  it('add_account_income records income against the account', async () => {
    const accountName = `AddIncome Account ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const created = (await callTool(client, {
        name: 'add_account_income',
        args: {
          description: `Salary ${stamp}`,
          amount: 3000,
          date: today,
          account: accountName,
          idempotencyKey: `add-account-income-${stamp}`,
        },
      })) as { transaction?: { type?: string; accountName?: string } };

      expect(created.transaction?.type).toBe('income');
      expect(created.transaction?.accountName).toBe(accountName);
    } finally {
      await transport.close();
    }
  });

  it('is idempotent — same idempotencyKey returns the existing movement', async () => {
    const accountName = `AddExpense Idempotent Account ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const args = {
        description: `Idempotent expense ${stamp}`,
        amount: 10,
        date: today,
        account: accountName,
        idempotencyKey: `add-account-expense-idempotent-${stamp}`,
      };

      const first = (await callTool(client, { name: 'add_account_expense', args })) as {
        created?: boolean;
        transaction?: { id?: string };
      };
      expect(first.created).toBe(true);

      const replay = (await callTool(client, { name: 'add_account_expense', args })) as {
        created?: boolean;
        transaction?: { id?: string };
      };
      expect(replay.created).toBe(false);
      expect(replay.transaction?.id).toBe(first.transaction?.id);
    } finally {
      await transport.close();
    }
  });

  it('rejects posting directly to a credit account', async () => {
    const cardName = `AddExpense CreditGuard Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const err = (await callToolError(client, {
        name: 'add_account_expense',
        args: {
          description: `Direct credit post ${stamp}`,
          amount: 10,
          date: today,
          account: cardName,
          idempotencyKey: `add-account-expense-credit-guard-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  // ADR-016 step 4: create_transaction (the god unified tool) is retired — add_account_expense is
  // now the sole account-expense entry point, so there's no sibling tool left to compare parity
  // against. The boundary-rejection cases it used to cover directly (empty category/subCategory/
  // account) are asserted below instead.
  it('rejects an explicitly empty category at the schema boundary', async () => {
    const stamp2 = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'add_account_expense',
            arguments: {
              description: `Empty category ${stamp2}`,
              amount: 10,
              category: '',
              idempotencyKey: `add-expense-empty-category-${stamp2}`,
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('rejects an explicitly empty subCategory at the schema boundary', async () => {
    const stamp2 = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'add_account_expense',
            arguments: {
              description: `Empty subCategory ${stamp2}`,
              amount: 10,
              subCategory: '',
              idempotencyKey: `add-expense-empty-subcategory-${stamp2}`,
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('rejects an explicitly empty account at the schema boundary', async () => {
    const stamp2 = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      // account was truthiness-gated downstream (input.account ? ... : null) in a past regression
      // — an explicitly empty name must be rejected, not silently treated as "no account".
      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'add_account_expense',
            arguments: {
              description: `Empty account ${stamp2}`,
              amount: 10,
              account: '',
              idempotencyKey: `add-expense-empty-account-${stamp2}`,
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('create_transactions_bulk routes an income line to add_account_income', async () => {
    const accountName = `AddIncome Bulk Account ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const result = (await callTool(client, {
        name: 'create_transactions_bulk',
        args: {
          items: [
            {
              description: `Bulk income line ${stamp}`,
              amount: 500,
              type: 'income',
              date: today,
              account: accountName,
              idempotencyKey: `bulk-income-${stamp}`,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; transaction?: { type?: string } }> };

      ensure(result.items?.length === 1, 'expected one bulk item result');
      expect(result.items[0]?.status).not.toBe('error');
      expect(result.items[0]?.transaction?.type).toBe('income');
    } finally {
      await transport.close();
    }
  });
});
