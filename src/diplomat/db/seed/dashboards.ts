// Baseline data-less dashboard template (ADR-013 Phase B). The layout/CSS/JS below is the only
// content of the seed — it embeds NO financial data. Every number rendered comes from a same-origin
// fetch('/api/...') issued by the browser after the page loads, against the routes documented at
// GET /api/openapi.json (src/diplomat/http/routes.ts). Overriding this default is a normal
// save_dashboard upsert (see diplomat/db/bootstrap.ts) — this seed only guarantees GET /ui/overview
// resolves on a fresh install.
export const DEFAULT_DASHBOARD_NAME = 'overview';

export const DEFAULT_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FinTrack — Overview</title>
    <script defer referrerpolicy="no-referrer" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --surface: #161b22;
        --surface-alt: #1c2333;
        --border: #30363d;
        --text: #e6edf3;
        --muted: #8b949e;
        --accent: #4f8cff;
        --positive: #3fb950;
        --negative: #f85149;
        --radius: 10px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        line-height: 1.4;
      }

      header {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1.5rem;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }

      header h1 {
        margin: 0;
        font-size: 1.25rem;
      }

      .subtitle {
        margin: 0.15rem 0 0;
        color: var(--muted);
        font-size: 0.8rem;
      }

      .controls {
        display: flex;
        flex-wrap: wrap;
        align-items: end;
        gap: 0.75rem;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .field label {
        font-size: 0.75rem;
        color: var(--muted);
      }

      select,
      input,
      button {
        background: var(--surface-alt);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.4rem 0.6rem;
        font-size: 0.85rem;
      }

      button {
        cursor: pointer;
        background: var(--accent);
        border-color: var(--accent);
        color: #06121f;
        font-weight: 600;
      }

      button.secondary {
        background: var(--surface-alt);
        color: var(--text);
        border-color: var(--border);
        font-weight: 500;
      }

      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 1.5rem;
      }

      section {
        margin-bottom: 2.5rem;
      }

      section h2 {
        font-size: 1rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        border-bottom: 1px solid var(--border);
        padding-bottom: 0.5rem;
        margin-bottom: 1rem;
      }

      .cards-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 1rem;
      }

      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 1rem;
      }

      .card h3 {
        margin: 0 0 0.75rem;
        font-size: 0.95rem;
        color: var(--accent);
      }

      .summary-metrics {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
        margin: 0;
      }

      .metric dt {
        margin: 0;
        font-size: 0.7rem;
        color: var(--muted);
      }

      .metric dd {
        margin: 0.15rem 0 0;
        font-size: 1rem;
        font-weight: 600;
      }

      .positive {
        color: var(--positive);
      }

      .negative {
        color: var(--negative);
      }

      .chart-wrap {
        position: relative;
        height: 220px;
        margin-bottom: 1rem;
      }

      .table-wrap {
        overflow-x: auto;
      }

      table.data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }

      table.data-table th,
      table.data-table td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }

      table.data-table th {
        color: var(--muted);
        font-weight: 500;
      }

      .state {
        margin: 0;
        padding: 1rem;
        color: var(--muted);
        font-style: italic;
      }

      .state-error {
        color: var(--negative);
        font-style: normal;
      }

      .placeholder-card {
        border: 1px dashed var(--border);
        border-radius: var(--radius);
        padding: 1.25rem;
        color: var(--muted);
        text-align: center;
      }

      footer {
        text-align: center;
        color: var(--muted);
        font-size: 0.75rem;
        padding: 1.5rem;
      }

      @media (max-width: 600px) {
        header {
          flex-direction: column;
          align-items: stretch;
        }

        .summary-metrics {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>FinTrack</h1>
        <p class="subtitle" id="last-updated">Not loaded yet</p>
      </div>
      <form class="controls" id="period-form">
        <div class="field">
          <label for="period-month">Month</label>
          <select id="period-month" name="month"></select>
        </div>
        <div class="field">
          <label for="period-year">Year</label>
          <input id="period-year" name="year" type="number" min="2000" max="2100" />
        </div>
        <button type="submit" id="apply-period">Apply</button>
        <button type="button" class="secondary" id="refresh-all">Refresh all</button>
      </form>
    </header>
    <main>
      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">Income / Expenses / Balance</h2>
        <div class="cards-grid" id="summary-cards" aria-live="polite"></div>
      </section>

      <section aria-labelledby="category-heading">
        <h2 id="category-heading">Spending by category</h2>
        <div class="cards-grid" id="category-spending-blocks" aria-live="polite"></div>
      </section>

      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading">Accounts &amp; balances</h2>
        <div class="table-wrap" id="accounts-table-wrap" aria-live="polite"></div>
      </section>

      <section aria-labelledby="recurring-heading">
        <h2 id="recurring-heading">Recurring</h2>
        <div class="table-wrap" id="recurring-table-wrap" aria-live="polite"></div>
      </section>

      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading">Recent transactions</h2>
        <div class="table-wrap" id="recent-transactions-table-wrap" aria-live="polite"></div>
      </section>

      <section aria-labelledby="installments-heading">
        <h2 id="installments-heading">Installment projections</h2>
        <div class="placeholder-card">Coming soon — no API endpoint publishes installment projections yet.</div>
      </section>
    </main>
    <footer>Data is fetched live from this device's local FinTrack API on every load. Nothing on this page is stored.</footer>

    <script>
      (function () {
        'use strict';

        var RECENT_TRANSACTIONS_LIMIT = 10;
        var CHART_COLORS = ['#4f8cff', '#3fb950', '#f2cc60', '#f85149', '#a371f7', '#39c5cf', '#ff9d5c', '#ff6bcb'];

        var Api = {
          summary: function (month, year) {
            return '/api/summary?month=' + month + '&year=' + year;
          },
          categorySpending: function (month, year) {
            return '/api/aggregate?groupBy=category&type=expense&month=' + month + '&year=' + year;
          },
          accountBalances: '/api/accounts/balances',
          recurring: '/api/recurring',
          recentTransactions: function (limit) {
            return '/api/transactions?limit=' + limit;
          },
        };

        var charts = {};
        var period = currentPeriod();

        // "Latest request wins" guard: rapid period changes / refresh clicks can resolve out of
        // order, so a stale response must never overwrite a newer one already on screen.
        var requestSequence = { summary: 0, categorySpending: 0, accounts: 0, recurring: 0, recentTransactions: 0 };

        function beginRequest(section) {
          return ++requestSequence[section];
        }

        function isCurrentRequest(section, requestId) {
          return requestSequence[section] === requestId;
        }

        function currentPeriod() {
          var now = new Date();
          return { month: now.getMonth() + 1, year: now.getFullYear() };
        }

        function monthName(monthNumber) {
          return new Date(2000, monthNumber - 1, 1).toLocaleString(undefined, { month: 'long' });
        }

        function h(tag, props, children) {
          var el = document.createElement(tag);
          if (props) {
            Object.keys(props).forEach(function (key) {
              if (key === 'class') el.className = props[key];
              else if (key === 'text') el.textContent = props[key];
              else el.setAttribute(key, props[key]);
            });
          }
          (children || []).forEach(function (child) {
            if (child) el.appendChild(child);
          });
          return el;
        }

        function clearNode(el) {
          while (el.firstChild) el.removeChild(el.firstChild);
        }

        function setLoading(el, message) {
          clearNode(el);
          el.appendChild(h('p', { class: 'state', text: message }));
        }

        function setEmpty(el, message) {
          clearNode(el);
          el.appendChild(h('p', { class: 'state', text: message }));
        }

        function setError(el, message) {
          clearNode(el);
          el.appendChild(h('p', { class: 'state state-error', role: 'alert', text: 'Could not load this section: ' + message }));
        }

        function fetchJson(path) {
          return fetch(path, { headers: { accept: 'application/json' } }).then(function (res) {
            if (res.ok) return res.json();
            return res
              .json()
              .catch(function () {
                return null;
              })
              .then(function (body) {
                var detail = res.statusText;
                if (body && body.error && Array.isArray(body.error.issues) && body.error.issues.length) {
                  detail = body.error.issues.join(', ');
                } else if (body && body.error && body.error.code) {
                  detail = body.error.code;
                }
                throw new Error('Request failed (' + res.status + '): ' + detail);
              });
          });
        }

        function formatMoney(amount, currency) {
          try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(amount);
          } catch (err) {
            return currency + ' ' + Number(amount).toFixed(2);
          }
        }

        function formatDate(isoDate) {
          var parsed = new Date(isoDate + 'T00:00:00');
          return isNaN(parsed.getTime()) ? isoDate : parsed.toLocaleDateString();
        }

        function amountClass(type) {
          if (type === 'income') return 'positive';
          if (type === 'expense') return 'negative';
          return '';
        }

        function markUpdated() {
          document.getElementById('last-updated').textContent = 'Last updated ' + new Date().toLocaleTimeString();
        }

        function initControls() {
          var monthSelect = document.getElementById('period-month');
          var yearInput = document.getElementById('period-year');
          for (var m = 1; m <= 12; m++) {
            var option = h('option', { value: String(m), text: monthName(m) });
            if (m === period.month) option.setAttribute('selected', 'selected');
            monthSelect.appendChild(option);
          }
          yearInput.value = String(period.year);

          document.getElementById('period-form').addEventListener('submit', function (event) {
            event.preventDefault();
            var month = parseInt(monthSelect.value, 10);
            var year = parseInt(yearInput.value, 10);
            if (!month || !year) return;
            period = { month: month, year: year };
            loadSummary();
            loadCategorySpending();
            markUpdated();
          });

          document.getElementById('refresh-all').addEventListener('click', loadAll);
        }

        function loadSummary() {
          var container = document.getElementById('summary-cards');
          var requestId = beginRequest('summary');
          setLoading(container, 'Loading summary…');
          fetchJson(Api.summary(period.month, period.year))
            .then(function (data) {
              if (!isCurrentRequest('summary', requestId)) return;
              if (!data.currencies || data.currencies.length === 0) {
                setEmpty(container, 'No transactions for this period yet.');
                return;
              }
              clearNode(container);
              data.currencies.forEach(function (block) {
                container.appendChild(renderSummaryCard(block));
              });
            })
            .catch(function (err) {
              if (!isCurrentRequest('summary', requestId)) return;
              setError(container, err.message);
            });
        }

        function renderSummaryCard(block) {
          return h('article', { class: 'card summary-card' }, [
            h('h3', { text: block.currency }),
            h('dl', { class: 'summary-metrics' }, [
              h('div', { class: 'metric' }, [h('dt', { text: 'Income' }), h('dd', { class: 'positive', text: formatMoney(block.income, block.currency) })]),
              h('div', { class: 'metric' }, [h('dt', { text: 'Expenses' }), h('dd', { class: 'negative', text: formatMoney(block.expenses, block.currency) })]),
              h('div', { class: 'metric' }, [
                h('dt', { text: 'Balance' }),
                h('dd', { class: block.balance >= 0 ? 'positive' : 'negative', text: formatMoney(block.balance, block.currency) }),
              ]),
            ]),
          ]);
        }

        function loadCategorySpending() {
          var container = document.getElementById('category-spending-blocks');
          var requestId = beginRequest('categorySpending');
          setLoading(container, 'Loading spending by category…');
          fetchJson(Api.categorySpending(period.month, period.year))
            .then(function (data) {
              if (!isCurrentRequest('categorySpending', requestId)) return;
              Object.keys(charts).forEach(function (key) {
                charts[key].destroy();
                delete charts[key];
              });
              var blocksWithRows = (data.currencies || []).filter(function (block) {
                return block.rows.length > 0;
              });
              if (blocksWithRows.length === 0) {
                setEmpty(container, 'No categorized spending for this period yet.');
                return;
              }
              clearNode(container);
              blocksWithRows.forEach(function (block) {
                var built = renderCategoryBlock(block);
                container.appendChild(built.wrap);
                if (typeof Chart !== 'undefined') {
                  charts[block.currency] = new Chart(built.canvas, {
                    type: 'doughnut',
                    data: {
                      labels: block.rows.map(function (row) {
                        return row.label;
                      }),
                      datasets: [
                        {
                          data: block.rows.map(function (row) {
                            return row.value;
                          }),
                          backgroundColor: block.rows.map(function (_row, index) {
                            return CHART_COLORS[index % CHART_COLORS.length];
                          }),
                        },
                      ],
                    },
                    options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: { legend: { position: 'bottom', labels: { color: '#e6edf3' } } },
                    },
                  });
                } else {
                  built.chartNote.textContent = 'Chart library unavailable — showing table only.';
                }
              });
            })
            .catch(function (err) {
              if (!isCurrentRequest('categorySpending', requestId)) return;
              setError(container, err.message);
            });
        }

        function renderCategoryBlock(block) {
          var canvas = document.createElement('canvas');
          canvas.setAttribute('aria-label', 'Spending by category chart (' + block.currency + ')');
          canvas.setAttribute('role', 'img');
          var chartNote = h('p', { class: 'state', text: '' });
          var table = h('table', { class: 'data-table' }, [
            h('thead', null, [h('tr', null, ['Category', 'Amount', 'Share'].map(function (title) {
              return h('th', { text: title });
            }))]),
            h(
              'tbody',
              null,
              block.rows.map(function (row) {
                return h('tr', null, [h('td', { text: row.label }), h('td', { text: formatMoney(row.value, block.currency) }), h('td', { text: row.pct.toFixed(1) + '%' })]);
              }),
            ),
          ]);
          var wrap = h('article', { class: 'card category-card' }, [h('h3', { text: block.currency }), h('div', { class: 'chart-wrap' }, [canvas]), chartNote, table]);
          return { wrap: wrap, canvas: canvas, chartNote: chartNote };
        }

        function loadAccounts() {
          var container = document.getElementById('accounts-table-wrap');
          var requestId = beginRequest('accounts');
          setLoading(container, 'Loading accounts…');
          fetchJson(Api.accountBalances)
            .then(function (accounts) {
              if (!isCurrentRequest('accounts', requestId)) return;
              if (!accounts.length) {
                setEmpty(container, 'No accounts yet.');
                return;
              }
              clearNode(container);
              container.appendChild(renderAccountsTable(accounts));
            })
            .catch(function (err) {
              if (!isCurrentRequest('accounts', requestId)) return;
              setError(container, err.message);
            });
        }

        function renderAccountsTable(accounts) {
          return h('table', { class: 'data-table' }, [
            h('thead', null, [h('tr', null, ['Account', 'Type', 'Currency', 'Balance'].map(function (title) {
              return h('th', { text: title });
            }))]),
            h(
              'tbody',
              null,
              accounts.map(function (account) {
                return h('tr', null, [
                  h('td', { text: account.name }),
                  h('td', { text: account.typeLabel || account.type }),
                  h('td', { text: account.currency }),
                  h('td', { class: account.balance >= 0 ? 'positive' : 'negative', text: formatMoney(account.balance, account.currency) }),
                ]);
              }),
            ),
          ]);
        }

        function loadRecurring() {
          var container = document.getElementById('recurring-table-wrap');
          var requestId = beginRequest('recurring');
          setLoading(container, 'Loading recurring rules…');
          fetchJson(Api.recurring)
            .then(function (rules) {
              if (!isCurrentRequest('recurring', requestId)) return;
              if (!rules.length) {
                setEmpty(container, 'No recurring rules set up yet.');
                return;
              }
              clearNode(container);
              container.appendChild(renderRecurringTable(rules));
            })
            .catch(function (err) {
              if (!isCurrentRequest('recurring', requestId)) return;
              setError(container, err.message);
            });
        }

        function renderRecurringTable(rules) {
          return h('table', { class: 'data-table' }, [
            h('thead', null, [h('tr', null, ['Description', 'Amount', 'Period', 'Next due', 'Account'].map(function (title) {
              return h('th', { text: title });
            }))]),
            h(
              'tbody',
              null,
              rules.map(function (rule) {
                return h('tr', null, [
                  h('td', { text: rule.description }),
                  h('td', { class: amountClass(rule.type), text: formatMoney(rule.amount, rule.currency) }),
                  h('td', { text: rule.periodLabel || rule.period }),
                  h('td', { text: formatDate(rule.nextDue) }),
                  h('td', { text: rule.accountName || '—' }),
                ]);
              }),
            ),
          ]);
        }

        function loadRecentTransactions() {
          var container = document.getElementById('recent-transactions-table-wrap');
          var requestId = beginRequest('recentTransactions');
          setLoading(container, 'Loading recent transactions…');
          fetchJson(Api.recentTransactions(RECENT_TRANSACTIONS_LIMIT))
            .then(function (transactions) {
              if (!isCurrentRequest('recentTransactions', requestId)) return;
              if (!transactions.length) {
                setEmpty(container, 'No transactions recorded yet.');
                return;
              }
              clearNode(container);
              container.appendChild(renderTransactionsTable(transactions));
            })
            .catch(function (err) {
              if (!isCurrentRequest('recentTransactions', requestId)) return;
              setError(container, err.message);
            });
        }

        function renderTransactionsTable(transactions) {
          return h('table', { class: 'data-table' }, [
            h('thead', null, [h('tr', null, ['Date', 'Description', 'Category', 'Account', 'Amount'].map(function (title) {
              return h('th', { text: title });
            }))]),
            h(
              'tbody',
              null,
              transactions.map(function (tx) {
                return h('tr', null, [
                  h('td', { text: formatDate(tx.date) }),
                  h('td', { text: tx.description }),
                  h('td', { text: tx.categoryName || '—' }),
                  h('td', { text: tx.accountName || tx.cardName || '—' }),
                  h('td', { class: amountClass(tx.type), text: formatMoney(tx.amount, tx.currency) }),
                ]);
              }),
            ),
          ]);
        }

        function loadAll() {
          loadSummary();
          loadCategorySpending();
          loadAccounts();
          loadRecurring();
          loadRecentTransactions();
          markUpdated();
        }

        document.addEventListener('DOMContentLoaded', function () {
          initControls();
          loadAll();
        });
      })();
    </script>
  </body>
</html>
`;
