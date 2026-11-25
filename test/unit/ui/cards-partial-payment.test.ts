import { describe, expect, it } from 'vitest';
import { loadFragment } from './fragment-sandbox.js';

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
