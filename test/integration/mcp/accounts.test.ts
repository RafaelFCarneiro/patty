import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, ensure, makeClient } from './helpers.js';

describe('MCP integration > accounts', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('reflects income and expense transactions in the derived account balance', async () => {
    const stamp = Date.now();
    const accountName = `Balance Test ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });

      const income = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Income ${stamp}`,
          amount: 500,
          type: 'income',
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: `integration-balance-income-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      if (income.transaction?.id) createdTxIds.push(income.transaction.id);

      const expense = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Expense ${stamp}`,
          amount: 200,
          type: 'expense',
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: `integration-balance-expense-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      if (expense.transaction?.id) createdTxIds.push(expense.transaction.id);

      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ name?: string; balance?: number }>;

      const bal = balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(1300); // 1000 initialBalance + 500 income - 200 expense
    } finally {
      await transport.close();
    }
  });
});
