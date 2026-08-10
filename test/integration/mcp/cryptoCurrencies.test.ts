import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, ensure, makeClient } from './helpers.js';

// ADR-026 Phase 1 — USDC/BTC are first-class currencies now: an account and a transaction can be
// created in them, and their native precision (6/8 decimals) must round-trip through create/read
// without being flattened to fiat's 2 decimals anywhere along the way.
describe('MCP integration > crypto currencies (ADR-026 Phase 1)', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('creates a BTC account and preserves 8-decimal precision through balance/summary reads', async () => {
    const stamp = Date.now();
    const accountName = `BTC Wallet ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'wallet', currency: 'BTC', initialBalance: 0.12345678 },
      })) as { id?: string; currency?: string; initialBalance?: number };
      expect(created.currency).toBe('BTC');
      expect(created.initialBalance).toBe(0.12345678);

      const income = (await callTool(client, {
        name: 'add_account_income',
        args: {
          description: `Mining reward ${stamp}`,
          amount: 0.00000001, // one satoshi
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: `integration-btc-income-${stamp}`,
        },
      })) as { transaction?: { id?: string; amount?: number } };
      if (income.transaction?.id) createdTxIds.push(income.transaction.id);
      expect(income.transaction?.amount).toBe(0.00000001);

      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ name?: string; balance?: number }>;
      const bal = balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(0.12345679); // 0.12345678 + 0.00000001, not rounded away

      const summary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month: Number(today.slice(5, 7)), year: Number(today.slice(0, 4)) },
      })) as { currencies?: Array<{ currency?: string; income?: number }> };
      const btcSummary = summary.currencies?.find((c) => c.currency === 'BTC');
      ensure(btcSummary, 'BTC summary block not found');
      expect(btcSummary.income).toBeGreaterThanOrEqual(0.00000001); // never flattened to 0
    } finally {
      await transport.close();
    }
  });

  it('creates a USDC account and preserves 6-decimal precision', async () => {
    const stamp = Date.now();
    const accountName = `USDC Wallet ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'wallet', currency: 'USDC', initialBalance: 100.123456 },
      })) as { currency?: string; initialBalance?: number };
      expect(created.currency).toBe('USDC');
      expect(created.initialBalance).toBe(100.123456);

      const expense = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Gas fee ${stamp}`,
          amount: 0.000001,
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: `integration-usdc-expense-${stamp}`,
        },
      })) as { transaction?: { id?: string; amount?: number } };
      if (expense.transaction?.id) createdTxIds.push(expense.transaction.id);
      expect(expense.transaction?.amount).toBe(0.000001);

      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ name?: string; balance?: number }>;
      const bal = balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(100.123455); // 100.123456 - 0.000001
    } finally {
      await transport.close();
    }
  });
});
