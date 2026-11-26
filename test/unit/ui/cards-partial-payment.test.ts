import { describe, expect, it } from 'vitest';
import { loadFragment, makeSessionStorage } from './fragment-sandbox.js';

// A bill shows "pago X de Y" and what remains once any part is paid; the pay form offers the remaining
// amount to change, and the revert button appears for a part-paid bill, not only a paid one.
const card = { id: 'card-1', name: 'Nubank', currency: 'BRL', limit: 1000, closingDay: 5, dueDay: 15 };

const bill = (overrides: Record<string, unknown> = {}) => ({
  id: 'bill-1',
  month: 6,
  year: 2026,
  closeDate: '2026-06-05',
  dueDate: '2026-06-15',
  status: 'closed',
  statusLabel: 'Fechada',
  paidAmount: 0,
  remaining: 100,
  partiallyPaid: false,
  payments: [],
  ...overrides,
});

const render = (billFields: Record<string, unknown>, total = 100) => {
  const { sandbox, document } = loadFragment('cards');
  sandbox.activeCard = card;
  sandbox.currentBill = { bill: bill(billFields), cardName: card.name, transactions: [], total };
  sandbox.renderBillSummary();
  const format = sandbox.formatMoney as (value: number, code: string) => string;
  return { sandbox, document, money: (value: number) => format(value, 'BRL') };
};

describe('cards.html bill summary with a partial payment', () => {
  it('shows pago X de Y and the remaining amount for a part-paid bill', () => {
    const { document, money } = render({
      paidAmount: 40,
      remaining: 60,
      partiallyPaid: true,
      payments: [{ id: 'tx-1', date: '2026-06-10', amount: 40 }],
    });

    expect(document.getElementById('bill-paid-row').style.display).toBe('flex');
    expect(document.getElementById('bill-remaining-row').style.display).toBe('flex');
    expect(document.getElementById('bill-paid-val').textContent).toBe(`Paid ${money(40)} of ${money(100)}`);
    expect(document.getElementById('bill-remaining-val').textContent).toBe(money(60));
  });

  it('keeps the pay button and offers the revert for a part-paid bill', () => {
    const { document } = render({
      paidAmount: 40,
      remaining: 60,
      payments: [{ id: 'tx-1', date: '2026-06-10', amount: 40 }],
    });

    expect(document.getElementById('btn-pay-bill').style.display).toBe('flex');
    expect(document.getElementById('btn-revert-pay').style.display).toBe('flex');
  });

  it('hides the paid and remaining rows when nothing is paid, and the revert button with them', () => {
    const { document } = render({});

    expect(document.getElementById('bill-paid-row').style.display).toBe('none');
    expect(document.getElementById('bill-remaining-row').style.display).toBe('none');
    expect(document.getElementById('btn-revert-pay').style.display).toBe('none');
  });

  it('a paid bill hides the pay button and shows what was paid with nothing remaining', () => {
    const { document, money } = render({
      status: 'paid',
      paidAmount: 100,
      remaining: 0,
      payments: [{ id: 'tx-1', date: '2026-06-10', amount: 100 }],
    });

    expect(document.getElementById('btn-pay-bill').style.display).toBe('none');
    expect(document.getElementById('btn-revert-pay').style.display).toBe('flex');
    expect(document.getElementById('bill-remaining-val').textContent).toBe(money(0));
  });
});

describe('cards.html pay form', () => {
  it('opens with the remaining amount as the amount to pay now', () => {
    const { sandbox, document, money } = render({ paidAmount: 40, remaining: 60 });
    sandbox.accounts = [];

    sandbox.openPayModal();

    expect(document.getElementById('pay-amount').value).toBe('60');
    expect(document.getElementById('pay-bill-total').textContent).toBe(money(60));
  });
});

describe('cards.html pay request', () => {
  const requestBody = (fields: Record<string, unknown>) => {
    const { sandbox } = render({});
    const bound = { card: 'Nubank', month: 6, year: 2026, account: 'Checking', date: '2026-06-10' };
    return JSON.parse(JSON.stringify(sandbox.payBillBody({ ...bound, ...fields })));
  };

  it('carries the payment token as the discriminator', () => {
    expect(requestBody({ amount: 50, token: 'tok-1' })).toMatchObject({ amount: 50, discriminator: 'tok-1' });
  });

  it('sends no amount when the remainder is not positive', () => {
    const body = requestBody({ amount: undefined, token: 'tok-1' });

    expect('amount' in body).toBe(false);
    expect('discriminator' in body).toBe(false);
  });

  it('disables the amount field for a non-positive remainder and enables it again otherwise', () => {
    const { sandbox, document } = render({ remaining: -5 }, 95);
    sandbox.accounts = [];

    sandbox.openPayModal();
    const input = document.getElementById('pay-amount');
    expect([input.disabled, input.required, input.value]).toEqual([true, false, '']);

    sandbox.currentBill = { ...sandbox.currentBill, bill: bill({ remaining: 60 }) };
    sandbox.openPayModal();
    expect([input.disabled, input.required, input.value]).toEqual([false, true, '60']);
  });
});

describe('cards.html payment revert', () => {
  const payments = [
    { id: 'tx-1', date: '2026-06-10', amount: 40, account: 'Checking' },
    { id: 'tx-2', date: '2026-06-10', amount: 60, account: 'Checking' },
  ];

  it('lets the person choose among several payments, latest first', () => {
    const { sandbox, document } = render({ paidAmount: 100, remaining: 0, status: 'paid', payments });

    sandbox.revertBillPayment();

    const options = Array.from(document.getElementById('revert-payment').children) as { value: string }[];
    expect(options.map((o) => o.value)).toEqual(['tx-2', 'tx-1']);
  });

  it('sends the chosen payment id', async () => {
    const { sandbox } = render({ paidAmount: 100, remaining: 0, status: 'paid', payments });
    const sent: unknown[] = [];
    sandbox.confirm = () => true;
    sandbox.loadBillDetails = async () => undefined;
    sandbox.fetch = async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({}) };
    };

    await sandbox.submitRevert('tx-1');

    expect(sent).toEqual([{ card: 'Nubank', month: 6, year: 2026, paymentId: 'tx-1' }]);
  });
});

describe('cards.html unfinished payments', () => {
  type Reply = 'ok' | 'refused' | 'network' | 'server';
  type Sent = { card: string; month: number; year: number; discriminator: string; amount: number };
  const billA = bill();
  const billB = bill({ id: 'bill-2', month: 7, closeDate: '2026-07-05', dueDate: '2026-07-15' });

  const open = (
    storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } = makeSessionStorage(),
  ) => {
    const { sandbox, document } = loadFragment('cards', { sessionStorage: storage });
    const sent: Sent[] = [];
    sandbox.activeCard = card;
    sandbox.accounts = [];
    sandbox.loadBillDetails = async () => undefined;
    const answer = (reply: Reply) => async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      if (reply === 'network') throw new Error('offline');
      if (reply === 'ok') return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: reply === 'refused' ? 400 : 503, json: async () => ({ error: { message: 'boom' } }) };
    };
    const show = (shown: ReturnType<typeof bill>) => {
      sandbox.currentBill = { bill: shown, cardName: card.name, transactions: [], total: 100 };
    };
    const submit = (fill: Record<string, string> = {}) => {
      const account = document.getElementById('pay-account');
      account.value = account.value || 'Checking';
      Object.entries(fill).forEach(([id, value]) => (document.getElementById(id).value = value));
      return sandbox.handlePaySubmit({ preventDefault: () => undefined });
    };
    const pay = async (shown: ReturnType<typeof bill>, reply: Reply, fill: Record<string, string> = {}) => {
      sandbox.fetch = answer(reply);
      show(shown);
      await sandbox.openPayModal();
      await submit(fill);
      return sent[sent.length - 1] as Sent;
    };
    const reopen = async (shown: ReturnType<typeof bill>, reply: Reply) => {
      sandbox.fetch = answer(reply);
      show(shown);
      await sandbox.openPayModal();
    };
    return { sandbox, document, sent, answer, show, submit, pay, reopen };
  };
  const kept = (storage: ReturnType<typeof makeSessionStorage>) =>
    Object.keys(JSON.parse(storage.getItem('patty.cards.payAttempts') ?? '{}'));

  it('reopening a bill with an unfinished payment resends it unchanged before a new payment is offered', async () => {
    const storage = makeSessionStorage();
    const { sandbox, sent, pay, reopen, submit } = open(storage);
    const lost = await pay(billA, 'network', { 'pay-amount': '70' });

    await reopen(billA, 'ok');

    expect(sent[1]).toEqual(lost);
    expect(kept(storage)).toEqual([]);
    expect(sandbox.payTarget).not.toBeNull();
    await submit({ 'pay-amount': '30' });
    expect(sent[2]?.discriminator).not.toBe(lost.discriminator);
    expect(sent[2]?.amount).toBe(30);
  });

  it('a 4xx on the resend clears the attempt (nothing was recorded) and offers a new payment', async () => {
    const storage = makeSessionStorage();
    const { sandbox, sent, pay, reopen } = open(storage);
    await pay(billA, 'network');

    await reopen(billA, 'refused');

    expect(sent).toHaveLength(2);
    expect(kept(storage)).toEqual([]);
    expect((sandbox.payTarget as { token: string }).token).not.toBe(sent[0]?.discriminator);
  });

  it('a network error on the resend keeps the attempt and does not open the form', async () => {
    const storage = makeSessionStorage();
    const { sandbox, sent, pay, reopen } = open(storage);
    const lost = await pay(billA, 'network');

    await reopen(billA, 'network');
    expect(kept(storage)).toEqual(['card-1:2026-6']);
    expect(sandbox.payTarget).toBeNull();

    await reopen(billA, 'server');
    expect(kept(storage)).toEqual(['card-1:2026-6']);
    expect(sent.map((s) => s.discriminator)).toEqual([lost.discriminator, lost.discriminator, lost.discriminator]);
  });

  it('keeps each bill’s attempt: a lost response on A survives a payment on B', async () => {
    const storage = makeSessionStorage();
    const { sent, pay, reopen } = open(storage);
    const lostOnA = await pay(billA, 'network');

    const onB = await pay(billB, 'ok');
    await reopen(billA, 'ok');

    expect(onB.discriminator).not.toBe(lostOnA.discriminator);
    expect(sent[2]).toEqual(lostOnA);
  });

  it('with A in flight, opening B and submitting it sends B’s own token and does not disturb A', async () => {
    const { sandbox, document, sent, answer, show, submit } = open();
    let finishA: (value: unknown) => void = () => undefined;
    sandbox.fetch = async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Promise((resolve) => (finishA = resolve));
    };
    show(billA);
    sandbox.openPayModal();
    const inFlightA = submit();
    expect(document.getElementById('btn-pay-bill').disabled).toBe(true);

    show(billB);
    sandbox.openPayModal();
    finishA({ ok: true, status: 200, json: async () => ({}) });
    await inFlightA;
    sandbox.fetch = answer('ok');
    await submit();

    expect(sent.map((s) => s.month)).toEqual([6, 7]);
    expect(sent[1]?.discriminator).not.toBe(sent[0]?.discriminator);
    expect(document.getElementById('btn-pay-bill').disabled).toBe(false);
  });

  it('refuses a second submit of the same form while its request is in flight', async () => {
    const { sandbox, sent, show, submit } = open();
    sandbox.fetch = async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Promise(() => undefined);
    };
    show(billA);
    sandbox.openPayModal();

    void submit();
    void submit();

    expect(sent).toHaveLength(1);
  });

  it('submits the bill the form was opened for, even when the bill on screen reloads meanwhile', async () => {
    const { sandbox, sent, answer, show, submit } = open();
    sandbox.fetch = answer('ok');
    show(billA);
    sandbox.openPayModal();

    show(billB);
    await submit();

    expect(sent[0]).toMatchObject({ card: 'Nubank', month: 6, year: 2026 });
  });

  it('survives a reload in the same tab: the new page resends the lost payment', async () => {
    const storage = makeSessionStorage();
    const lost = await open(storage).pay(billA, 'network');

    const reloaded = open(storage);
    await reloaded.reopen(billA, 'ok');

    expect(reloaded.sent[0]).toEqual(lost);
    expect(kept(storage)).toEqual([]);
  });

  it('drops the entry of a bill that shows as settled', async () => {
    const storage = makeSessionStorage();
    const { sandbox, show, pay } = open(storage);
    await pay(billA, 'network');

    show(bill({ status: 'paid', paidAmount: 100, remaining: 0 }));
    sandbox.renderBillSummary();

    expect(kept(storage)).toEqual([]);
  });

  it('keeps resending the same token when storage is unavailable or its writes fail', async () => {
    const failing = {
      getItem: makeSessionStorage().getItem,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const { sent, pay, reopen } = open(failing);
    const lost = await pay(billA, 'network');

    await reopen(billA, 'ok');

    expect(sent[1]).toEqual(lost);
  });
});
