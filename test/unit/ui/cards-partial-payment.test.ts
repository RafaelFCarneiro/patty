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
    return JSON.parse(JSON.stringify(sandbox.payBillBody({ account: 'Checking', date: '2026-06-10', ...fields })));
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
  const billA = bill();
  const billB = bill({ id: 'bill-2', month: 7, closeDate: '2026-07-05', dueDate: '2026-07-15' });

  const open = (storage = makeSessionStorage()) => {
    const { sandbox, document } = loadFragment('cards', { sessionStorage: storage });
    sandbox.activeCard = card;
    sandbox.accounts = [];
    sandbox.loadBillDetails = async () => undefined;
    const show = (shown: ReturnType<typeof bill>) => {
      sandbox.currentBill = { bill: shown, cardName: card.name, transactions: [], total: 100 };
    };
    const submit = async (shown: ReturnType<typeof bill>, ok: boolean, fill: Record<string, string> = {}) => {
      const sent: Record<string, unknown>[] = [];
      sandbox.fetch = async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return { ok, json: async () => ({ error: { message: 'boom' } }) };
      };
      show(shown);
      sandbox.openPayModal();
      const account = document.getElementById('pay-account');
      account.value = account.value || 'Checking';
      Object.entries(fill).forEach(([id, value]) => (document.getElementById(id).value = value));
      await sandbox.handlePaySubmit({ preventDefault: () => undefined });
      return sent[0] as { discriminator: string; amount: number; paymentDate: string };
    };
    return { sandbox, document, submit, show, storage };
  };
  const kept = (storage: ReturnType<typeof makeSessionStorage>) =>
    Object.keys(JSON.parse(storage.getItem('patty.cards.payAttempts') ?? '{}'));

  it('resends the same payment after a failure and starts fresh after a success', async () => {
    const { submit, show, sandbox, document } = open();

    const failed = await submit(billA, false, { 'pay-amount': '70', 'pay-date': '2026-06-09' });
    show(bill({ remaining: 30, paidAmount: 70 }));
    sandbox.openPayModal();
    expect(document.getElementById('pay-amount').value).toBe('70');
    expect(document.getElementById('pay-amount').max).toBe('');
    const retried = await submit(bill({ remaining: 30, paidAmount: 70 }), true, {});
    const next = await submit(billA, true, { 'pay-amount': '30' });

    expect(retried).toEqual(failed);
    expect(next.discriminator).not.toBe(failed.discriminator);
    expect(document.getElementById('pay-amount').max).toBe('100');
  });

  it('keeps each bill’s attempt: a lost response on A survives a payment on B, and B’s success leaves A', async () => {
    const { submit, storage } = open();

    const lostOnA = await submit(billA, false);
    const onB = await submit(billB, true);
    const reopenedA = await submit(billA, false);

    expect(onB.discriminator).not.toBe(lostOnA.discriminator);
    expect(reopenedA.discriminator).toBe(lostOnA.discriminator);
    expect(kept(storage)).toEqual(['card-1:2026-6']);
  });

  it('survives a reload in the same tab, and a success clears the entry', async () => {
    const storage = makeSessionStorage();
    const lost = await open(storage).submit(billA, false);

    const reloaded = open(storage);
    const resent = await reloaded.submit(billA, true);

    expect(resent.discriminator).toBe(lost.discriminator);
    expect(kept(storage)).toEqual([]);
    expect((await open(storage).submit(billA, true)).discriminator).not.toBe(lost.discriminator);
  });

  it('drops the entry of a bill that shows as settled', async () => {
    const { submit, show, sandbox, storage } = open();
    await submit(billA, false);

    show(bill({ status: 'paid', paidAmount: 100, remaining: 0 }));
    sandbox.renderBillSummary();

    expect(kept(storage)).toEqual([]);
  });

  it('falls back to memory when the browser storage is unavailable', async () => {
    const { sandbox, document } = loadFragment('cards');
    sandbox.activeCard = card;
    sandbox.accounts = [];
    sandbox.loadBillDetails = async () => undefined;
    const sent: { discriminator: string }[] = [];
    const run = async (ok: boolean) => {
      sandbox.fetch = async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return { ok, json: async () => ({ error: { message: 'boom' } }) };
      };
      sandbox.currentBill = { bill: billA, cardName: card.name, transactions: [], total: 100 };
      sandbox.openPayModal();
      document.getElementById('pay-account').value = 'Checking';
      await sandbox.handlePaySubmit({ preventDefault: () => undefined });
    };

    await run(false);
    await run(true);

    expect(sent[1]?.discriminator).toBe(sent[0]?.discriminator);
  });

  it('keeps resending the same token when storage reads work but writes fail', async () => {
    const storage = makeSessionStorage();
    const readOnly = {
      getItem: storage.getItem,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const { submit } = open(readOnly);

    const lost = await submit(billA, false);
    const retried = await submit(billA, true);

    expect(retried.discriminator).toBe(lost.discriminator);
  });
});
