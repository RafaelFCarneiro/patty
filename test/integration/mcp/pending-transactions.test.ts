import { afterEach, describe, expect, it } from 'vitest';
import { callTool, callToolError, deleteTransactions, makeClient, searchTransactions } from './helpers.js';

describe('MCP integration > pending transactions', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  // Always use a fresh isolated account so balance assertions are exact regardless
  // of what other tests or the environment have left behind.
  const freshAccount = async (client: Awaited<ReturnType<typeof makeClient>>['client'], stamp: number) => {
    const name = `Pending Test ${stamp}`;
    await callTool(client, {
      name: 'create_account',
      args: { name, type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
    return name;
  };

  it('pending transaction is excluded from balances and summaries; confirm flips it', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);
      const accountName = await freshAccount(client, stamp);

      // Past-dated income with no explicit status → should default to effective
      const effective = (await callTool(client, {
        name: 'add_account_income',
        args: {
          description: `PTEST EFFECTIVE ${stamp}`,
          amount: 1000,
          date: '2026-01-15',
          account: accountName,
        },
      })) as { transaction?: { id?: string; status?: string } };
      const effId = effective.transaction?.id;
      if (!effId) throw new Error('missing effective tx id');
      createdTxIds.push(effId);
      expect(effective.transaction?.status).toBe('effective');

      // Explicit pending expense
      const pending = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `PTEST PENDING ${stamp}`,
          amount: 300,
          date: '2026-01-20',
          account: accountName,
          status: 'pending',
        },
      })) as { transaction?: { id?: string; status?: string } };
      const pendId = pending.transaction?.id;
      if (!pendId) throw new Error('missing pending tx id');
      createdTxIds.push(pendId);
      expect(pending.transaction?.status).toBe('pending');

      // Balance reflects only the effective income (1000), NOT the pending expense
      const { balances } = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as { balances: Array<{ balance?: number; projectedBalance?: number }> };
      expect(balances[0]?.balance).toBe(1000);
      expect(balances[0]?.projectedBalance).toBeUndefined();

      // projectedAsOf includes the pending expense
      const { balances: projected } = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName, projectedAsOf: '2026-01-31' },
      })) as { balances: Array<{ balance?: number; projectedBalance?: number }> };
      expect(projected[0]?.balance).toBe(1000);
      expect(projected[0]?.projectedBalance).toBe(700);

      // Spending summary should NOT include the pending expense
      const summary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month: 1, year: 2026 },
      })) as { currencies?: Array<Record<string, unknown>> };
      const brlSummary = summary.currencies?.find((c) => c['currency'] === 'BRL') as
        { totalExpenses?: number } | undefined;
      expect(brlSummary?.totalExpenses ?? 0).toBe(0);

      // status filter returns only pending transactions for this account
      const pendingList = (await searchTransactions(client, {
        status: 'pending',
        account: accountName,
        limit: 50,
      })) as Array<{ id?: string }>;
      expect(pendingList.some((t) => t.id === pendId)).toBe(true);
      expect(pendingList.some((t) => t.id === effId)).toBe(false);

      // confirm flips pending → effective
      const confirmed = (await callTool(client, {
        name: 'confirm_transaction',
        args: { id: pendId },
      })) as { status?: string };
      expect(confirmed.status).toBe('effective');

      // confirming again is a no-op (returns effective)
      const reconfirm = (await callTool(client, {
        name: 'confirm_transaction',
        args: { id: pendId },
      })) as { status?: string };
      expect(reconfirm.status).toBe('effective');

      // Balance now drops by 300 after confirm
      const { balances: afterConfirm } = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as { balances: Array<{ balance?: number }> };
      expect(afterConfirm[0]?.balance).toBe(700);
    } finally {
      await transport.close();
    }
  });

  it('date-aware default: future date without explicit status lands pending', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);
      const accountName = await freshAccount(client, stamp + 1);

      // Future-dated, no status → should default to pending via the date-aware rule
      const futureTx = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `PTEST FUTURE DEFAULT ${stamp}`,
          amount: 500,
          date: '2099-01-01',
          account: accountName,
        },
      })) as { transaction?: { id?: string; status?: string } };
      const futureId = futureTx.transaction?.id;
      if (!futureId) throw new Error('missing future tx id');
      createdTxIds.push(futureId);
      expect(futureTx.transaction?.status).toBe('pending');

      // Past-dated, no status → should default to effective
      const pastTx = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `PTEST PAST DEFAULT ${stamp}`,
          amount: 200,
          date: '2020-01-01',
          account: accountName,
        },
      })) as { transaction?: { id?: string; status?: string } };
      const pastId = pastTx.transaction?.id;
      if (!pastId) throw new Error('missing past tx id');
      createdTxIds.push(pastId);
      expect(pastTx.transaction?.status).toBe('effective');
    } finally {
      await transport.close();
    }
  });

  it('confirm-with-edit corrects amount/date on an account movement and flips it effective', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);
      const accountName = await freshAccount(client, stamp + 2);

      const pending = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `PTEST EDIT ${stamp}`,
          amount: 100,
          date: '2026-01-10',
          account: accountName,
          status: 'pending',
        },
      })) as { transaction?: { id?: string } };
      const id = pending.transaction?.id;
      if (!id) throw new Error('missing pending tx id');
      createdTxIds.push(id);

      const confirmed = (await callTool(client, {
        name: 'confirm_transaction',
        args: { id, amount: 150, date: '2026-01-12' },
      })) as { status?: string; amount?: number; date?: string };
      expect(confirmed.status).toBe('effective');
      expect(confirmed.amount).toBe(150);
      expect(confirmed.date).toBe('2026-01-12');
    } finally {
      await transport.close();
    }
  });

  it('confirm-with-edit is rejected for a transfer; a plain confirm of the same transfer still works', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);
      const fromAccount = await freshAccount(client, stamp + 3);
      const toAccount = await freshAccount(client, stamp + 4);

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: {
          from: fromAccount,
          to: toAccount,
          amount: 50,
          date: '2026-01-10',
          status: 'pending',
        },
      })) as { transaction?: { id?: string } };
      const id = transfer.transaction?.id;
      if (!id) throw new Error('missing transfer tx id');
      createdTxIds.push(id);

      const editErr = (await callToolError(client, {
        name: 'confirm_transaction',
        args: { id, amount: 999 },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(editErr.error?.code).toBe('validation');
      expect(editErr.error?.issues?.[0]).toContain('update_account_transaction');

      const confirmed = (await callTool(client, {
        name: 'confirm_transaction',
        args: { id },
      })) as { status?: string; amount?: number };
      expect(confirmed.status).toBe('effective');
      expect(confirmed.amount).toBe(50);
    } finally {
      await transport.close();
    }
  });

  it('rejects confirming to a future date, whether via an explicit edit or the existing date', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);
      const accountName = await freshAccount(client, stamp + 5);

      const pastPending = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `PTEST FUTURE EDIT ${stamp}`,
          amount: 10,
          date: '2026-01-10',
          account: accountName,
          status: 'pending',
        },
      })) as { transaction?: { id?: string } };
      const pastPendingId = pastPending.transaction?.id;
      if (!pastPendingId) throw new Error('missing pending tx id');
      createdTxIds.push(pastPendingId);

      const futureEditErr = (await callToolError(client, {
        name: 'confirm_transaction',
        args: { id: pastPendingId, date: '2099-01-01' },
      })) as { error?: { code?: string } };
      expect(futureEditErr.error?.code).toBe('validation');

      const futurePending = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `PTEST FUTURE EXISTING ${stamp}`,
          amount: 10,
          date: '2099-01-01',
          account: accountName,
        },
      })) as { transaction?: { id?: string; status?: string } };
      const futurePendingId = futurePending.transaction?.id;
      if (!futurePendingId) throw new Error('missing future pending tx id');
      createdTxIds.push(futurePendingId);
      expect(futurePending.transaction?.status).toBe('pending');

      const plainConfirmErr = (await callToolError(client, {
        name: 'confirm_transaction',
        args: { id: futurePendingId },
      })) as { error?: { code?: string } };
      expect(plainConfirmErr.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });
});
