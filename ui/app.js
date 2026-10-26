// FinTrack app shell client (ADR-027 Phase 1) — vanilla JS, no build step. Renders the dashboard
// menu from GET /api/dashboards, loads the selected dashboard's fragment from
// GET /api/dashboards/:name, and injects it into #content. Client-side navigation between
// dashboards never reloads the page. ADR-027 Phase 3 adds live update: one EventSource for the
// life of the page (fragment swaps never reopen it), forwarding each message to whichever
// fragment is currently loaded via the window.fintrackOnDataChanged contract (see connectEvents
// below) — the shell knows nothing about a fragment's own sections, only that one may want to
// know when data changed.
(function () {
  'use strict';

  window.addEventListener('error', function (e) {
    showDiagnosticError(e.error ? e.error.message + '\n' + e.error.stack : e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    showDiagnosticError('Unhandled Promise Rejection: ' + (e.reason ? (e.reason.stack || e.reason.message || e.reason) : e));
  });

  function showDiagnosticError(message) {
    console.error("DIAGNOSTIC ERROR CAUGHT:", message);
    var errDiv = document.getElementById('shell-diagnostic-error');
    if (!errDiv) {
      errDiv = document.createElement('div');
      errDiv.id = 'shell-diagnostic-error';
      errDiv.style.cssText = 'position: fixed; top: 10px; right: 10px; left: 10px; background: rgba(220, 38, 38, 0.95); color: #fff; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; z-index: 10000; box-shadow: 0 4px 12px rgba(0,0,0,0.5); white-space: pre-wrap; overflow-y: auto; max-height: 200px; border: 1px solid #ef4444;';
      var closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'float: right; background: none; border: none; color: #fff; font-size: 16px; cursor: pointer; margin-left: 10px;';
      closeBtn.onclick = function() { errDiv.remove(); };
      errDiv.appendChild(closeBtn);
      var pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = message;
      errDiv.appendChild(pre);
      document.body.appendChild(errDiv);
    } else {
      var existingPre = errDiv.querySelector('pre');
      if (existingPre) existingPre.textContent += '\n\n' + message;
    }
  }

  var DEFAULT_DASHBOARD_NAME = 'overview';
  var UI_PATH_PREFIX = '/ui/';
  var EVENTS_PATH = '/ui/events';
  var currentLocale = 'en';

  var DASHBOARD_ICONS = {
    overview: 'fa-chart-pie',
    accounts: 'fa-building-columns',
    cards: 'fa-credit-card',
    categories: 'fa-sitemap',
    tags: 'fa-tags',
    pending: 'fa-clock',
    projections: 'fa-chart-line',
    comparative: 'fa-scale-balanced',
    dashboards: 'fa-sliders',
    budget: 'fa-bullseye'
  };

  var LOCALIZED_TOOLTIPS = {
    en: {
      overview: 'Overview',
      accounts: 'Bank Accounts',
      cards: 'Credit Cards',
      categories: 'Categories',
      tags: 'Tags',
      pending: 'Pending',
      projections: 'Projections',
      comparative: 'Comparative',
      dashboards: 'Dashboards Manager',
      budget: 'Budget'
    },
    pt: {
      overview: 'Visão Geral',
      accounts: 'Contas Bancárias',
      cards: 'Cartões de Crédito',
      categories: 'Categorias',
      tags: 'Tags',
      pending: 'Pendentes',
      projections: 'Projeções',
      comparative: 'Comparativo',
      dashboards: 'Gerenciador de Dashboards',
      budget: 'Orçamento'
    },
    es: {
      overview: 'Visión General',
      accounts: 'Cuentas Bancarias',
      cards: 'Tarjetas de Crédito',
      categories: 'Categorías',
      tags: 'Tags',
      pending: 'Pendientes',
      projections: 'Proyecciones',
      comparative: 'Comparativo',
      dashboards: 'Gestor de Dashboards',
      budget: 'Presupuesto'
    }
  };

  // Module-scope, not local to connectEvents() — an EventSource with no surviving reference to the
  // object itself risks being garbage-collected in some implementations even with a handler
  // attached, which would silently stop live update. Also guards connectEvents() itself against
  // ever opening a second connection.
  var eventSource = null;

  var Api = {
    status: '/api/status',
    dashboards: '/api/dashboards',
    currencies: '/api/currencies',
    preferences: '/api/preferences',
    dashboard: function (name) {
      return '/api/dashboards/' + encodeURIComponent(name);
    },
  };

  // Keyed by code — window.formatMoney (ui/money.js) reads this to format a currency Intl's
  // currency mode can't handle correctly: USDC (4 letters) throws, BTC (3 letters, syntactically
  // valid) doesn't throw but silently mis-formats with fiat-shaped precision and no real symbol.
  // Both fall back to this currency's own symbol/decimals instead.
  function indexCurrenciesByCode(currencies) {
    var map = {};
    (currencies || []).forEach(function (c) {
      map[c.code] = c;
    });
    return map;
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
      if (typeof child === 'string') el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
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

  function setError(el, message) {
    clearNode(el);
    el.appendChild(h('p', { class: 'state state-error', role: 'alert', text: 'Could not load: ' + message }));
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

  // Only the first path segment after /ui/ names the dashboard — anything past that (there is no
  // such route today) is ignored rather than rejected, so a stray trailing slash still resolves.
  function currentDashboardName() {
    var path = window.location.pathname;
    if (path.indexOf(UI_PATH_PREFIX) !== 0) return DEFAULT_DASHBOARD_NAME;
    var name = path.slice(UI_PATH_PREFIX.length).split('/')[0];
    return name ? decodeURIComponent(name) : DEFAULT_DASHBOARD_NAME;
  }

  function nameFromMenuHref(href) {
    return decodeURIComponent(href.slice(UI_PATH_PREFIX.length));
  }

  // A fragment's <script> tags are inert once injected via innerHTML — replacing each with a
  // freshly created <script> element is what actually triggers execution once it lands back in
  // the live document. The fragment's own script runs its init synchronously at this point (it
  // can't rely on DOMContentLoaded, which only ever fires once for the whole shell page).
  function executeScripts(container) {
    container.querySelectorAll('script').forEach(function (oldScript) {
      // save_dashboard already rejects a src= script server-side (fragments carry zero external
      // references — the shell owns Chart.js now), but a row saved before that check existed
      // could still carry one; never execute it client-side either.
      if (oldScript.hasAttribute('src')) {
        oldScript.remove();
        return;
      }
      var newScript = document.createElement('script');
      for (var i = 0; i < oldScript.attributes.length; i++) {
        var attr = oldScript.attributes[i];
        newScript.setAttribute(attr.name, attr.value);
      }
      newScript.textContent = oldScript.textContent;
      oldScript.replaceWith(newScript);
    });
  }

  function renderFragment(container, html) {
    // Reset before tearing down the outgoing fragment's DOM, not after injecting the new one — a
    // stale closure referencing already-removed elements must never fire again, and a fragment
    // whose own script errors before reaching its own registration simply gets no live update
    // rather than the previous fragment's.
    window.fintrackOnDataChanged = null;
    clearNode(container);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    while (temp.firstChild) container.appendChild(temp.firstChild);
    executeScripts(container);
  }

  function loadDashboard(name) {
    var container = document.getElementById('content');
    setLoading(container, 'Loading dashboard…');
    return fetchJson(Api.dashboard(name) + '?t=' + Date.now())
      .then(function (dashboard) {
        document.title = 'FinTrack — ' + dashboard.name;
        renderFragment(container, dashboard.html);
      })
      .catch(function (err) {
        setError(container, err.message);
      });
  }

  function menuLink(dashboard, activeName) {
    var key = dashboard.name.toLowerCase();
    var tooltipText = dashboard.name;
    var iconClass = DASHBOARD_ICONS[key] || 'fa-chart-simple';
    
    var dict = LOCALIZED_TOOLTIPS[currentLocale] || LOCALIZED_TOOLTIPS['en'];
    if (dict && dict[key]) {
      tooltipText = dict[key];
    }

    var iconEl = h('i', { class: 'fa-solid ' + iconClass });
    var link = h('a', {
      href: UI_PATH_PREFIX + encodeURIComponent(dashboard.name),
      title: tooltipText,
      'aria-label': tooltipText
    }, [iconEl]);

    if (dashboard.name === activeName) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
    return link;
  }

  function dropdownLink(dashboard, activeName) {
    var key = dashboard.name.toLowerCase();
    var displayText = dashboard.name;
    var iconClass = DASHBOARD_ICONS[key] || 'fa-chart-simple';
    
    var dict = LOCALIZED_TOOLTIPS[currentLocale] || LOCALIZED_TOOLTIPS['en'];
    if (dict && dict[key]) {
      displayText = dict[key];
    }

    var iconEl = h('i', { class: 'fa-solid ' + iconClass });
    var link = h('a', { href: UI_PATH_PREFIX + encodeURIComponent(dashboard.name) }, [iconEl, ' ' + displayText]);

    if (dashboard.name === activeName) {
      link.classList.add('active');
    }
    return link;
  }

  // ADR-027 Phase 2: file-backed defaults get a fixed slot in mainSequence/dropdownSequence below;
  // inline (custom) dashboards are never in either list, so they always fall through to the
  // dropdown, after a divider once at least one exists.
  function renderMenu(dashboards, activeName) {
    var nav = document.getElementById('dashboard-menu');
    clearNode(nav);
    var dropdown = document.getElementById('more-dropdown');
    clearNode(dropdown);

    // Order of items in the main sidebar list:
    var mainSequence = ['overview', 'pending', 'budget', 'comparative', 'projections', 'accounts', 'cards'];
    // Order of items in the dropdown list:
    var dropdownSequence = ['categories', 'tags', 'dashboards'];

    // Map by name lowercase for fast lookup
    var dbMap = {};
    dashboards.forEach(function(d) {
      dbMap[d.name.toLowerCase()] = d;
    });

    // 1. Render main sequence icons
    mainSequence.forEach(function(nameKey) {
      var d = dbMap[nameKey];
      if (d) {
        nav.appendChild(menuLink(d, activeName));
      }
    });

    // 2. Render dropdown sequence text items
    dropdownSequence.forEach(function(nameKey) {
      var d = dbMap[nameKey];
      if (d) {
        dropdown.appendChild(dropdownLink(d, activeName));
      }
    });

    // 3. Render any custom (user-uploaded) dashboards inside the dropdown as well
    var customs = dashboards.filter(function(d) {
      var key = d.name.toLowerCase();
      return d.source !== 'file' && mainSequence.indexOf(key) === -1 && dropdownSequence.indexOf(key) === -1;
    });

    if (customs.length > 0) {
      var divider = h('hr', { class: 'sidebar-divider', style: 'width: 90%; margin: 0.25rem auto;' });
      dropdown.appendChild(divider);
      customs.forEach(function(d) {
        dropdown.appendChild(dropdownLink(d, activeName));
      });
    }
  }

  function updateActiveMenuLink(activeName) {
    document.querySelectorAll('#dashboard-menu a, #more-dropdown a').forEach(function (link) {
      var isActive = nameFromMenuHref(link.getAttribute('href')) === activeName;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function navigate(name, push) {
    if (push) window.history.pushState(null, '', UI_PATH_PREFIX + encodeURIComponent(name));
    updateActiveMenuLink(name);
    return loadDashboard(name);
  }

  window.addEventListener('popstate', function () {
    navigate(currentDashboardName(), false);
  });

  // ADR-027 Phase 3 — live update. Opened once, for the page's whole lifetime; fragment swaps
  // (navigate/renderFragment above) never touch this connection, only the
  // window.fintrackOnDataChanged slot it delivers into. EventSource reconnects on its own after a
  // drop (the browser's built-in retry), so no reconnect logic is needed here; a message that
  // arrives with no fragment currently registered (or between "torn down" and "registered again")
  // is simply dropped — the next live-relevant fetch a user triggers (period change, manual
  // refresh) always reflects current data regardless.
  function connectEvents() {
    if (typeof EventSource === 'undefined' || eventSource) return;
    eventSource = new EventSource(EVENTS_PATH);
    eventSource.onmessage = function (event) {
      var payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(payload.entities)) return;
      var forward = function () {
        if (typeof window.fintrackOnDataChanged === 'function') window.fintrackOnDataChanged(payload.entities);
      };
      if (payload.entities.indexOf('userSettings') === -1) return forward();
      // A base-currency change updates the default before the fragment re-renders with it.
      fetchJson(Api.preferences)
        .then(function (prefs) {
          window.setBaseCurrency(prefs && prefs.baseCurrency);
        })
        .catch(function (err) {
          console.error('Could not refresh preferences:', err);
        })
        .then(forward);
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    var menu = document.getElementById('dashboard-menu');
    menu.addEventListener('click', function (event) {
      var link = event.target.closest('a');
      if (!link) return;
      event.preventDefault();
      navigate(nameFromMenuHref(link.getAttribute('href')), true);
    });

    var dropdown = document.getElementById('more-dropdown');
    var moreContainer = document.getElementById('more-container');
    var moreBtn = document.getElementById('more-btn');
    
    if (dropdown && moreContainer && moreBtn) {
      var setMoreOpen = function (open) {
        moreContainer.classList.toggle('open', open);
        moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };

      dropdown.addEventListener('click', function (event) {
        var link = event.target.closest('a');
        if (!link) return;
        event.preventDefault();
        setMoreOpen(false);
        navigate(nameFromMenuHref(link.getAttribute('href')), true);
      });

      moreBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        setMoreOpen(!moreContainer.classList.contains('open'));
      });

      document.addEventListener('click', function () {
        setMoreOpen(false);
      });
    }

    var initialName = currentDashboardName();

    // Currency metadata (symbol/decimals) must be cached before the first dashboard renders — its
    // fragment script calls window.formatMoney synchronously while rendering, with no re-render on
    // late-arriving data. Sequenced with locale (both fast local calls); the dashboards list fetch
    // (menu chrome) stays parallel to content, same as before this sequencing existed.
    var bootPromise = fetchJson(Api.status)
      .then(function (status) {
        if (status && status.locale) {
          currentLocale = status.locale;
        }
      })
      .catch(function () {
        // Fallback to English silently
      })
      .then(function () {
        return fetchJson(Api.currencies);
      })
      .then(function (currencies) {
        window.__fintrackCurrencies = indexCurrenciesByCode(currencies);
      })
      .catch(function (err) {
        // Fiat (BRL/USD) is unaffected — formatMoney's ISO path never reads this metadata. A
        // crypto amount (BTC/USDC) would silently degrade to fiat-shaped 2-decimal precision and
        // no real symbol without it, which is exactly the wrong-precision-with-no-signal gotcha
        // this file exists to avoid — so surface it loudly instead of proceeding silently.
        window.__fintrackCurrencies = window.__fintrackCurrencies || {};
        showDiagnosticError(
          'Could not load currency metadata: ' +
            err.message +
            '. Crypto amounts (BTC/USDC) may display at the wrong precision until this is refreshed.',
        );
      });

    // Base currency resolves before any fragment renders (a fragment reads DEFAULT_CURRENCY
    // synchronously); a failure keeps the last-resort default and never blocks the page.
    bootPromise = bootPromise
      .then(function () {
        return fetchJson(Api.preferences);
      })
      .then(function (prefs) {
        window.setBaseCurrency(prefs && prefs.baseCurrency);
      })
      .catch(function (err) {
        console.error('Could not load preferences; keeping the default currency:', err);
      });

    bootPromise.then(function () {
      return loadDashboard(initialName);
    }).then(function () {
      connectEvents();
    });

    bootPromise
      .then(function () {
        return fetchJson(Api.dashboards);
      })
      .then(function (dashboards) {
        renderMenu(dashboards, initialName);
      })
      .catch(function (err) {
        setError(menu, err.message);
      });
  });
})();
