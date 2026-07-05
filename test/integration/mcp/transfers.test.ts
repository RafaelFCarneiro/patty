import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, ensure, makeClient, searchTransactions } from './helpers.js';

describe('MCP integration > transfers', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('debits source and credits destination without appearing as expense or income', async () => {
    const stamp = Date.now();
    const sourceName = `Transfer Source ${stamp}`;
    const destName = `Transfer Dest ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: sourceName, type: 'checking', currency: 'BRL', initialBalance: 500 },
      });
      await callTool(client, {
        name: 'create_account',
        args: { name: destName, type: 'savings', currency: 'BRL', initialBalance: 0 },
      });

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: {
          from: sourceName,
          to: destName,
          amount: 200,
          date: today,
          description: `Transfer ${stamp}`,
          idempotencyKey: `integration-transfer-${stamp}`,
        },
      })) as { transaction?: { id?: string }; created?: boolean };

      const txId = transfer.transaction?.id;
      ensure(txId, 'Transfer transaction id missing');
      createdTxIds.push(txId);
      expect(transfer.created).toBe(true);

      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: {},
      })) as Array<{ name?: string; balance?: number }>;

      const src = balances.find((b) => b.name === sourceName);
      const dst = balances.find((b) => b.name === destName);
      ensure(src, `Balance for "${sourceName}" not found`);
      ensure(dst, `Balance for "${destName}" not found`);
      expect(src.balance).toBe(300); // 500 - 200
      expect(dst.balance).toBe(200); // 0 + 200

      // Visible in account statement when filtering by type
      const statement = (await searchTransactions(client, {
        account: sourceName,
        type: 'transfer',
        limit: 10,
      })) as Array<{ id?: string }>;
      expect(statement.some((tx) => tx.id === txId)).toBe(true);

      // Absent from expense and income filters
      const expenses = (await searchTransactions(client, {
        account: sourceName,
        type: 'expense',
        limit: 50,
      })) as Array<{ id?: string }>;
      const incomes = (await searchTransactions(client, {
        account: sourceName,
        type: 'income',
        limit: 50,
      })) as Array<{ id?: string }>;
      expect(expenses.every((tx) => tx.id !== txId)).toBe(true);
      expect(incomes.every((tx) => tx.id !== txId)).toBe(true);
    } finally {
      await transport.close();
    }
  });
});
