import { describe, expect, it } from 'vitest';
import { loadFragment } from './fragment-sandbox.js';

// pending.html's primary currency, KPI lines, chart selector and chart titles follow the user's
// data and base currency instead of a hardcoded BRL.
type Tx = {
  type: 'income' | 'expense';
  amount: number;
  currency?: string;
  description?: string;
  categoryName?: string;
};
const tx = (overrides: Partial<Tx>): Tx => ({
  type: 'expense',
  amount: 0,
  description: 'x',
  categoryName: 'Food',
  ...overrides,
});

const loadPending = (transactions: Tx[], baseCurrency?: string) => {
  const loaded = loadFragment('pending', { baseCurrency });
  loaded.sandbox.allTransactions = transactions;
  loaded.sandbox.updateKPIs();
  loaded.sandbox.renderCharts();
  const money = loaded.sandbox.formatMoney as (value: number, code: string) => string;
  const html = (id: string) => loaded.document.getElementById(id).innerHTML;
  return { ...loaded, money, html };
};

describe('pending.html currency handling', () => {
  it('shows a USD-only user USD in the KPIs and charts, with no BRL anywhere', () => {
    const { html, money, charts, document } = loadPending([
      tx({ type: 'income', amount: 500, currency: 'USD' }),
      tx({ type: 'expense', amount: 120, currency: 'USD', categoryName: 'Rent' }),
    ]);
    expect(html('kpi-total-income')).toBe(`<span>${money(500, 'USD')}</span>`);
    expect(html('kpi-total-expense')).toBe(`<span>${money(120, 'USD')}</span>`);
    expect(html('kpi-net-balance')).toBe(`<span>${money(380, 'USD')}</span>`);
    expect(html('kpi-net-balance')).not.toContain('R$');
    expect(charts[0]?.data.datasets[0]?.data).toEqual([120]);
    expect(document.getElementById('chart-currency-group').style.display).toBe('none');
    expect(document.getElementById('chart-title-category').textContent).toBe('Expenses by Category (USD)');
  });

  it('keeps a BRL-only user on exactly the BRL view, with no selector', () => {
    const { html, money, charts, document } = loadPending([
      tx({ type: 'income', amount: 1000, currency: 'BRL' }),
      tx({ type: 'expense', amount: 300, currency: 'BRL' }),
    ]);
    expect(html('kpi-total-income')).toBe(`<span>${money(1000, 'BRL')}</span>`);
    expect(html('kpi-net-balance')).toBe(`<span>${money(700, 'BRL')}</span>`);
    expect(charts[0]?.data.datasets[0]?.data).toEqual([300]);
    expect(document.getElementById('chart-currency-group').style.display).toBe('none');
  });

  it('offers a selector for a BRL+USD period, defaulting to the base currency, and never mixes currencies', () => {
    const { sandbox, html, money, charts, document } = loadPending(
      [
        tx({ type: 'expense', amount: 300, currency: 'BRL', description: 'a' }),
        tx({ type: 'expense', amount: 40, currency: 'USD', description: 'b' }),
      ],
      'USD',
    );
    expect(html('kpi-total-expense')).toBe(
      `<span>${money(40, 'USD')}</span><span class="secondary-val">${money(300, 'BRL')}</span>`,
    );
    expect(document.getElementById('chart-currency-group').style.display).toBe('');
    expect(html('chart-currency-select')).toBe('<option value="USD">USD</option><option value="BRL">BRL</option>');
    expect(charts[0]?.data.datasets[0]?.data).toEqual([40]);

    const select = document.getElementById('chart-currency-select');
    select.value = 'BRL';
    select.fireEvent('change');
    expect(sandbox.chartCurrency).toBe('BRL');
    expect(charts[2]?.data.datasets[0]?.data).toEqual([300]);
    expect(document.getElementById('chart-title-top').textContent).toBe('Top Pending Expenses (BRL)');
  });

  it('defaults the selector to the most active currency when no base currency is set', () => {
    const { sandbox } = loadPending([
      tx({ amount: 10, currency: 'BRL' }),
      tx({ amount: 900, currency: 'USD' }),
    ]);
    expect(sandbox.primary).toBe('USD');
    expect(sandbox.chartCurrency).toBe('USD');
  });

  it.each([
    ['en', 'Expenses by Category (MXN)', 'Top Pending Expenses (MXN)'],
    ['pt', 'Despesas por Categoria (MXN)', 'Maiores Despesas Previstas (MXN)'],
    ['es', 'Gastos por Categoría (MXN)', 'Mayores Gastos Previstos (MXN)'],
  ])('carries the selected currency code in the %s chart titles', (locale, category, top) => {
    const { sandbox, document } = loadPending([tx({ amount: 5, currency: 'MXN' })]);
    sandbox.currentLocale = locale;
    sandbox.translateChartTitles();
    expect(document.getElementById('chart-title-category').textContent).toBe(category);
    expect(document.getElementById('chart-title-top').textContent).toBe(top);
  });

  it.each(['en', 'pt', 'es'])('defines the new chart labels in %s', (locale) => {
    const { sandbox } = loadPending([]);
    const dictionary = sandbox.TRANSLATIONS[locale];
    expect(dictionary.pending_chart_by_category).toContain('{currency}');
    expect(dictionary.pending_chart_top_expenses).toContain('{currency}');
    expect(dictionary.pending_chart_currency_label).toBeTruthy();
  });
});
