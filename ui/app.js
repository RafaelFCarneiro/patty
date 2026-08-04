// FinTrack app shell client (ADR-027 Phase 1) — vanilla JS, no build step. Renders the dashboard
// menu from GET /api/dashboards, loads the selected dashboard's fragment from
// GET /api/dashboards/:name, and injects it into #content. Client-side navigation between
// dashboards never reloads the page.
(function () {
  'use strict';

  var DEFAULT_DASHBOARD_NAME = 'overview';
  var UI_PATH_PREFIX = '/ui/';

  var Api = {
    dashboards: '/api/dashboards',
    dashboard: function (name) {
      return '/api/dashboards/' + encodeURIComponent(name);
    },
  };

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
    clearNode(container);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    while (temp.firstChild) container.appendChild(temp.firstChild);
    executeScripts(container);
  }

  function loadDashboard(name) {
    var container = document.getElementById('content');
    setLoading(container, 'Loading dashboard…');
    return fetchJson(Api.dashboard(name))
      .then(function (dashboard) {
        document.title = 'FinTrack — ' + dashboard.name;
        renderFragment(container, dashboard.html);
      })
      .catch(function (err) {
        setError(container, err.message);
      });
  }

  function menuLink(dashboard, activeName) {
    var link = h('a', { href: UI_PATH_PREFIX + encodeURIComponent(dashboard.name), text: dashboard.name });
    if (dashboard.name === activeName) link.classList.add('active');
    return link;
  }

  // ADR-027 Phase 2: source is the sole default/custom discriminator — file-backed dashboards
  // render as flat top-level items, inline (custom) ones group under a labeled "Custom" submenu,
  // straight off list_dashboards (no separate grouping field to keep in sync).
  function renderMenu(dashboards, activeName) {
    var nav = document.getElementById('dashboard-menu');
    clearNode(nav);

    var defaults = dashboards.filter(function (dashboard) {
      return dashboard.source === 'file';
    });
    var customs = dashboards.filter(function (dashboard) {
      return dashboard.source !== 'file';
    });

    defaults.forEach(function (dashboard) {
      nav.appendChild(menuLink(dashboard, activeName));
    });

    if (customs.length > 0) {
      var group = h('div', { class: 'dashboard-menu-group', id: 'dashboard-menu-custom' }, [
        h('span', { class: 'dashboard-menu-group-label', text: 'Custom' }),
      ]);
      customs.forEach(function (dashboard) {
        group.appendChild(menuLink(dashboard, activeName));
      });
      nav.appendChild(group);
    }
  }

  function updateActiveMenuLink(activeName) {
    document.querySelectorAll('#dashboard-menu a').forEach(function (link) {
      link.classList.toggle('active', nameFromMenuHref(link.getAttribute('href')) === activeName);
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

  document.addEventListener('DOMContentLoaded', function () {
    var menu = document.getElementById('dashboard-menu');
    menu.addEventListener('click', function (event) {
      var link = event.target.closest('a');
      if (!link) return;
      event.preventDefault();
      navigate(nameFromMenuHref(link.getAttribute('href')), true);
    });

    var initialName = currentDashboardName();
    fetchJson(Api.dashboards)
      .then(function (dashboards) {
        renderMenu(dashboards, initialName);
      })
      .catch(function (err) {
        setError(menu, err.message);
      });
    loadDashboard(initialName);
  });
})();
