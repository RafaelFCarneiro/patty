import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, ensure, makeClient } from './helpers.js';

// Feature Design 022 phase 0 — MXN and COP are first-class fiat currencies: an account and a
// transaction can be created in them, and each currency is summarised on its own (never converted).
describe('MCP integration > peso currencies (Feature Design 022)', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('creates MXN and COP accounts and expenses, keeping balances and summary per currency', async () => {
    const stamp = Date.now();
    const today = toIsoDate(new Date());
    const pesos = [
      { currency: 'MXN', account: `Cuenta MXN ${stamp}`, initialBalance: 1000, amount: 250.5 },
      { currency: 'COP', account: `Cuenta COP ${stamp}`, initialBalance: 2_000_000, amount: 45_000.25 },
    ];

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      for (const { currency, account, initialBalance, amount } of pesos) {
        const created = (await callTool(client, {
          name: 'create_account',
          args: { name: account, type: 'checking', currency, initialBalance },
        })) as { currency?: string };
        expect(created.currency).toBe(currency);

        const expense = (await callTool(client, {
          name: 'add_account_expense',
          args: { description: `Compra ${currency} ${stamp}`, amount, date: today, account, category: 'Other' },
        })) as { transaction?: { id?: string; amount?: number; currency?: string } };
        if (expense.transaction?.id) createdTxIds.push(expense.transaction.id);
        expect(expense.transaction).toMatchObject({ amount, currency });
      }

      const { balances } = (await callTool(client, { name: 'get_account_balances' })) as {
        balances: Array<{ name?: string; currency?: string; balance?: number }>;
      };
      for (const { currency, account, initialBalance, amount } of pesos) {
        const balance = balances.find((b) => b.name === account);
        ensure(balance, `Balance for "${account}" not found`);
        expect(balance).toMatchObject({ currency, balance: Math.round((initialBalance - amount) * 100) / 100 });
      }

      const summary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month: Number(today.slice(5, 7)), year: Number(today.slice(0, 4)) },
      })) as { currencies?: Array<{ currency?: string; expenses?: number }> };
      for (const { currency, amount } of pesos) {
        const block = summary.currencies?.find((c) => c.currency === currency);
        ensure(block, `${currency} summary block not found`);
        expect(block.expenses).toBeGreaterThanOrEqual(amount);
      }
    } finally {
      await transport.close();
    }
  });

  it('rejects a currency outside the enum (ARS) at the boundary', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, {
          name: 'create_account',
          args: { name: `Cuenta ARS ${Date.now()}`, type: 'checking', currency: 'ARS' },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});
