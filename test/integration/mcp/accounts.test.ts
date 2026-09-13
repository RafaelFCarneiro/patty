import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, ensure, makeClient } from './helpers.js';

type BalancesResult = {
  balances: Array<{ converted?: { baseCurrency: string; value: number; rate: number; stale: boolean } }>;
  consolidatedNetWorth: { baseCurrency: string; total: number; excluded: string[] };
};

describe('MCP integration > accounts', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('creates an account via the functional-core-imperative-shell write path (ADR-021)', async () => {
    const stamp = Date.now();
    const accountName = `UoW MCP Account ${stamp}`;

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 250 },
      })) as { id?: string; name?: string; initialBalance?: number };

      expect(created.id).toBeTruthy();
      expect(created.name).toBe(accountName);
      expect(created.initialBalance).toBe(250);
      // `version` is the applier's internal optimistic-concurrency token — never on the wire.
      expect(created).not.toHaveProperty('version');

      const result = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as { balances: Array<{ name?: string; balance?: number }> };
      const bal = result.balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(250);
    } finally {
      await transport.close();
    }
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
        name: 'add_account_income',
        args: {
          description: `Income ${stamp}`,
          amount: 500,
          date: today,
          account: accountName,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      if (income.transaction?.id) createdTxIds.push(income.transaction.id);

      const expense = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Expense ${stamp}`,
          amount: 200,
          date: today,
          account: accountName,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      if (expense.transaction?.id) createdTxIds.push(expense.transaction.id);

      const result = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as { balances: Array<{ name?: string; balance?: number }> };

      const bal = result.balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(1300); // 1000 initialBalance + 500 income - 200 expense
    } finally {
      await transport.close();
    }
  });

  it('valuation (ADR-026): converts a non-base-currency balance and reports a consolidated net worth', async () => {
    const stamp = Date.now();
    const usdName = `Val USD ${stamp}`;
    const brlName = `Val BRL ${stamp}`;

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      // Self-contained: this suite shares one MCP server/DB across every integration test file
      // (base-currency.test.ts), so base_currency/currency_rates are global state — set both
      // explicitly rather than assuming whatever another file left behind.
      await callTool(client, { name: 'set_base_currency', args: { baseCurrency: 'USD' } });
      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() },
      });

      await callTool(client, {
        name: 'create_account',
        args: { name: usdName, type: 'checking', currency: 'USD', initialBalance: 100 },
      });
      await callTool(client, {
        name: 'create_account',
        args: { name: brlName, type: 'checking', currency: 'BRL', initialBalance: 500 },
      });

      const usdResult = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: usdName },
      })) as BalancesResult;
      expect(usdResult.balances[0]?.converted).toMatchObject({
        baseCurrency: 'USD',
        value: 100,
        rate: 1,
        stale: false,
      });
      expect(usdResult.consolidatedNetWorth).toEqual({ baseCurrency: 'USD', total: 100, excluded: [] });

      const brlResult = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: brlName },
      })) as BalancesResult;
      expect(brlResult.balances[0]?.converted).toMatchObject({
        baseCurrency: 'USD',
        value: 100,
        rate: 0.2,
        stale: false,
      });
      expect(brlResult.consolidatedNetWorth).toEqual({ baseCurrency: 'USD', total: 100, excluded: [] });
    } finally {
      await transport.close();
    }
  });
});
