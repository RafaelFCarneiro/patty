import { describe, expect, it } from 'vitest';
import { loadFragment, type StubElement } from './fragment-sandbox.js';

// cards.html builds its currency selects from the shell's currency metadata and falls back to the
// user's base currency, never a hardcoded BRL/USD pair.
const optionValues = (select: StubElement) => [...select.innerHTML.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
const ALL_CURRENCIES = ['BRL', 'BTC', 'COP', 'MXN', 'USD', 'USDC'].sort();

const card = (currency: string) => ({ id: `card-${currency}`, name: `Card ${currency}`, currency, limit: 1000, closingDay: 5, dueDay: 15 });

describe('cards.html currency handling', () => {
  it('lists every seeded currency in the add form and preselects the base currency', () => {
    const { sandbox, document } = loadFragment('cards', { baseCurrency: 'USD' });
    sandbox.accounts = [];
    sandbox.openAddCardModal();
    const select = document.getElementById('card-add-currency');
    expect(optionValues(select)).toEqual(ALL_CURRENCIES);
    expect(select.innerHTML).toContain('MXN (MX$)');
    expect(select.value).toBe('USD');
  });

  it('preselects the last-resort default in the add form when no base currency is set', () => {
    const { sandbox, document } = loadFragment('cards');
    sandbox.accounts = [];
    sandbox.openAddCardModal();
    expect(document.getElementById('card-add-currency').value).toBe('BRL');
  });

  it('keeps the card own currency in the edit form, whatever the base currency is', () => {
    const { sandbox, document } = loadFragment('cards', { baseCurrency: 'USD' });
    sandbox.accounts = [];
    sandbox.activeCard = card('COP');
    sandbox.openEditCardModal();
    const select = document.getElementById('card-edit-currency');
    expect(optionValues(select)).toEqual(ALL_CURRENCIES);
    expect(select.value).toBe('COP');
  });

  it('formats an MXN card day-group totals in MXN', () => {
    const { sandbox, document } = loadFragment('cards', { baseCurrency: 'USD' });
    sandbox.renderTxItem = () => {};
    sandbox.activeCard = card('MXN');
    sandbox.currentBill = { transactions: [{ type: 'expense', date: '2026-10-01', description: 'a', amount: 1234.5 }] };
    sandbox.renderTransactionsTable();
    const list = document.getElementById('bill-txs-list');
    const format = sandbox.formatMoney as (value: number, code: string) => string;
    expect(list.innerHTML).toContain(format(1234.5, 'MXN'));
    expect(list.innerHTML).toContain('MX$');
  });

  it.each(['MXN', 'COP'])('offers a %s account as payment account for a card in that currency', (currency) => {
    const { sandbox, document } = loadFragment('cards');
    sandbox.activeCard = card(currency);
    sandbox.currentBill = { total: 10, bill: { month: 10, year: 2026 } };
    sandbox.accounts = [
      { id: 'a1', name: `Main ${currency}`, type: 'checking', currency },
      { id: 'a2', name: 'Other BRL', type: 'checking', currency: 'BRL' },
    ];
    sandbox.openPayModal();
    const names = document.getElementById('pay-account').children.map((option) => option.textContent);
    expect(names).toEqual([`Main ${currency}`]);
  });
});
