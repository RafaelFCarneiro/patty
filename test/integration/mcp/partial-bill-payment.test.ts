import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, ensure, makeClient, searchTransactions } from './helpers.js';

type Client = ReturnType<typeof makeClient>['client'];
type Payment = { id: string; date: string; amount: number; account?: string };
type SettledBill = {
  status: string;
  paidAmount: number;
  remaining: number;
  partiallyPaid: boolean;
  payments: Payment[];
  paymentTransactionId?: string;
};
type ToolError = { error?: { code?: string; issues?: string[]; hint?: string } };

describe('MCP integration > partial bill payment (Feature Design 025)', () => {
  const now = new Date();
  const stamp = now.getTime();
  // Day 15 is always inside the closingDay=28 cycle, so every purchase lands on this one bill.
  const pinned = new Date(now.getFullYear(), now.getMonth(), 15);
  const today = toIsoDate(pinned);
  const month = pinned.getMonth() + 1;
  const year = pinned.getFullYear();
  const dayBefore = toIsoDate(new Date(year, pinned.getMonth(), 14));

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(pinned);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  let seq = 0;
  const withBill = async (
    run: (ctx: { client: Client; card: string; bank: string; purchaseId: string }) => Promise<void>,
    options: { purchase?: number } = {},
  ) => {
    seq += 1;
    const card = `Partial Card ${stamp}-${seq}`;
    const bank = `Partial Bank ${stamp}-${seq}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'create_account',
        args: { name: bank, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: card, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bank },
      });
      const purchase = (await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Partial purchase ${stamp}-${seq}`,
          amount: options.purchase ?? 100,
          type: 'expense',
          date: today,
          card,
        },
      })) as { transaction: { id: string } };
      await run({ client, card, bank, purchaseId: purchase.transaction.id });
    } finally {
      await transport.close();
    }
  };

  const pay = (client: Client, card: string, args: Record<string, unknown> = {}) =>
    callTool(client, { name: 'pay_bill', args: { card, month, year, ...args } }) as Promise<SettledBill>;
  const revert = (client: Client, card: string, args: Record<string, unknown> = {}) =>
    callTool(client, { name: 'revert_bill_payment', args: { card, month, year, ...args } }) as Promise<SettledBill>;
  const getBill = async (client: Client, card: string) =>
    (await callTool(client, { name: 'get_bill', args: { card, month, year } })) as { bill: SettledBill; total: number };
  const balanceOf = async (client: Client, account: string): Promise<number | undefined> => {
    const { balances } = (await callTool(client, { name: 'get_account_balances', args: { account } })) as {
      balances: Array<{ balance?: number }>;
    };
    return balances[0]?.balance;
  };
  const failure = async (client: Client, name: string, args: Record<string, unknown>) =>
    (await callToolError(client, { name, args })) as ToolError;

  it('a payment below the total leaves the bill unpaid but part paid; the remainder settles it', async () => {
    await withBill(async ({ client, card, bank }) => {
      const partial = await pay(client, card, { amount: 40 });
      expect(partial).toMatchObject({ status: 'open', paidAmount: 40, remaining: 60, partiallyPaid: true });
      expect(partial.payments).toHaveLength(1);
      expect(partial.payments[0]).toMatchObject({ date: today, amount: 40, account: bank });
      expect(partial.paymentTransactionId).toBe(partial.payments[0]?.id);
      expect(await balanceOf(client, bank)).toBe(960);
      expect(await balanceOf(client, `Card: ${card}`)).toBe(-60);

      const read = await getBill(client, card);
      expect(read.total).toBe(100);
      expect(read.bill).toMatchObject({ status: 'open', paidAmount: 40, remaining: 60, partiallyPaid: true });

      const settled = await pay(client, card);
      expect(settled).toMatchObject({ status: 'paid', paidAmount: 100, remaining: 0, partiallyPaid: false });
      expect(settled.payments.map((p) => p.amount)).toEqual([40, 60]);
      expect(await balanceOf(client, bank)).toBe(900);
      expect(await balanceOf(client, `Card: ${card}`)).toBe(0);
    });
  });

  it('without an amount the whole bill is paid, as before', async () => {
    await withBill(async ({ client, card }) => {
      expect(await pay(client, card)).toMatchObject({ status: 'paid', paidAmount: 100, remaining: 0 });
      expect(await pay(client, card)).toMatchObject({ status: 'paid', paidAmount: 100 });
    });
  });

  it('an amount above what remains is refused, naming the remaining amount', async () => {
    await withBill(async ({ client, card, bank }) => {
      await pay(client, card, { amount: 40 });

      const refused = await failure(client, 'pay_bill', { card, month, year, amount: 70 });

      expect(refused.error?.code).toBe('validation');
      expect(refused.error?.issues?.join(' ')).toContain('(60)');
      expect(await balanceOf(client, bank)).toBe(960);
    });
  });

  it('repeating a payment is a no-op, and a discriminator records a second identical one', async () => {
    await withBill(async ({ client, card, bank }) => {
      await pay(client, card, { amount: 30 });
      expect((await pay(client, card, { amount: 30 })).payments).toHaveLength(1);
      expect(await balanceOf(client, bank)).toBe(970);

      const second = await pay(client, card, { amount: 30, discriminator: 'again' });

      expect(second).toMatchObject({ paidAmount: 60, remaining: 40 });
      expect(second.payments).toHaveLength(2);
      expect(await balanceOf(client, bank)).toBe(940);
    });
  });

  it('revert_bill_payment undoes the only payment, or the one named; from paid the bill closes', async () => {
    await withBill(async ({ client, card, bank }) => {
      const early = await pay(client, card, { amount: 40, paymentDate: dayBefore });
      const both = await pay(client, card, { amount: 60 });
      const [earlyId, lateId] = both.payments.map((p) => p.id);
      ensure(earlyId && lateId && early.payments[0]?.id === earlyId, 'expected both payment ids');

      const lateUndone = await revert(client, card, { paymentId: lateId });
      expect(lateUndone).toMatchObject({ status: 'closed', paidAmount: 40, remaining: 60, partiallyPaid: true });
      expect(await balanceOf(client, bank)).toBe(960);

      const nothingLeft = await revert(client, card);
      expect(nothingLeft).toMatchObject({ status: 'closed', paidAmount: 0, remaining: 100, payments: [] });
      expect(await balanceOf(client, bank)).toBe(1000);
      expect(await revert(client, card)).toMatchObject({ paidAmount: 0, payments: [] });
    });
  });

  it('revert_bill_payment needs the payment named among several; a repeated or foreign id is a no-op', async () => {
    await withBill(async ({ client, card, bank }) => {
      await pay(client, card, { amount: 30 });
      const both = await pay(client, card, { amount: 20 });
      const ids = both.payments.map((p) => p.id);
      expect(ids).toHaveLength(2);

      const ambiguous = await failure(client, 'revert_bill_payment', { card, month, year });
      expect(ambiguous.error?.code).toBe('validation');
      for (const id of ids) expect(ambiguous.error?.issues?.join(' ')).toContain(id);

      const [firstId] = ids;
      ensure(firstId, 'expected the first payment id');
      expect((await revert(client, card, { paymentId: firstId })).payments).toHaveLength(1);
      expect(await balanceOf(client, bank)).toBe(980);

      const repeated = await revert(client, card, { paymentId: firstId });
      expect(repeated).toMatchObject({ paidAmount: 20, payments: [expect.anything()] });
      expect(await revert(client, card, { paymentId: 'not-a-payment' })).toMatchObject({ paidAmount: 20 });
      expect(await balanceOf(client, bank)).toBe(980);
    });
  });

  it('a purchase on a part-paid bill raises what remains', async () => {
    await withBill(async ({ client, card }) => {
      await pay(client, card, { amount: 40 });

      await callTool(client, {
        name: 'add_card_purchase',
        args: { description: `Late purchase ${stamp}`, amount: 50, type: 'expense', date: today, card },
      });

      expect((await getBill(client, card)).bill).toMatchObject({ paidAmount: 40, remaining: 110, status: 'open' });
    });
  });

  it('a change that would bring the total below what is paid is refused, with a pointer at the revert', async () => {
    await withBill(async ({ client, card, purchaseId }) => {
      await pay(client, card, { amount: 40 });

      const refund = await failure(client, 'add_card_purchase', {
        description: `Refund ${stamp}`,
        amount: 70,
        type: 'income',
        date: today,
        card,
      });
      expect(refund.error?.code).toBe('validation');
      expect(refund.error?.hint).toBe('use revert_bill_payment');

      const lowered = await failure(client, 'update_card_transaction', { id: purchaseId, amount: 30 });
      expect(lowered.error?.hint).toBe('use revert_bill_payment');

      const deleted = await failure(client, 'delete_card_transaction', { id: purchaseId, confirm: true });
      expect(deleted.error?.hint).toBe('use revert_bill_payment');

      await callTool(client, {
        name: 'add_card_purchase',
        args: { description: `Small refund ${stamp}`, amount: 50, type: 'income', date: today, card },
      });
      expect((await getBill(client, card)).bill).toMatchObject({ paidAmount: 40, remaining: 10 });
    });
  });

  it('the payment transfer of a bill that is not yet paid cannot be edited or deleted, only reverted', async () => {
    await withBill(async ({ client, card }) => {
      const partial = await pay(client, card, { amount: 40 });
      const paymentId = partial.payments[0]?.id;
      ensure(paymentId, 'expected the payment id');

      const deleted = await failure(client, 'delete_card_transaction', { id: paymentId, confirm: true });
      expect(deleted.error?.hint).toBe('use revert_bill_payment');
      const edited = await failure(client, 'update_card_transaction', { id: paymentId, description: 'edited' });
      expect(edited.error?.hint).toBe('use revert_bill_payment');

      const still = (await searchTransactions(client, { text: `Bill payment: ${card}`, limit: 10 })) as Array<{
        id?: string;
      }>;
      expect(still.map((tx) => tx.id)).toContain(paymentId);
    });
  });

  it('delete_credit_card removes every payment of every bill and restores the payer', async () => {
    await withBill(async ({ client, card, bank }) => {
      await pay(client, card, { amount: 40 });
      await pay(client, card, { amount: 25 });
      expect(await balanceOf(client, bank)).toBe(935);

      await callTool(client, { name: 'delete_credit_card', args: { card, confirm: true } });

      expect(await balanceOf(client, bank)).toBe(1000);
      const left = (await searchTransactions(client, { text: `Bill payment: ${card}`, limit: 10 })) as unknown[];
      expect(left).toHaveLength(0);
    });
  });
});
