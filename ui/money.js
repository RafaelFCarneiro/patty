// Crypto-aware money formatter (ADR-026 Phase 1). A non-ISO code isn't reliably a throw: per
// ECMA-402, Intl.NumberFormat's currency style only rejects a syntactically-malformed code (not
// exactly 3 letters, e.g. 'USDC') — a syntactically-valid-but-unrecognized 3-letter code like 'BTC'
// silently formats with a fiat-shaped 2 decimals and no real symbol instead of throwing, which
// would flatten BTC's precision exactly like the gotcha this file exists to avoid. So the ISO check
// below is explicit (Intl.supportedValuesOf('currency')) rather than try/catch — a currency missing
// from that list falls back to its own symbol + decimals from /api/currencies metadata (cached on
// window.__fintrackCurrencies, populated once at shell boot — see app.js).
(function () {
  'use strict';

  // window.DEFAULT_CURRENCY reads this instead of repeating the literal.
  var BRL = 'BRL';

  var isoCurrencyCache = null;

  function isIsoCurrency(code) {
    if (typeof Intl.supportedValuesOf !== 'function') {
      // Pre-Enumeration-API engine (no modern evergreen browser lacks this) — best-effort via
      // throw/no-throw: correct for a malformed code like USDC, silently wrong precision for a
      // well-formed-but-unrecognized 3-letter code like BTC until the engine is updated.
      try {
        // Constructed only to probe for a thrown RangeError.
        new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
        return true;
      } catch {
        return false;
      }
    }
    if (!isoCurrencyCache) isoCurrencyCache = Intl.supportedValuesOf('currency');
    return isoCurrencyCache.indexOf(code) !== -1;
  }

  function metaFor(code) {
    var meta = window.__fintrackCurrencies;
    return (meta && meta[code]) || null;
  }

  // Each peso formats in its own market's style (BRL pt-BR, MXN es-MX, COP es-CO); everything
  // else defaults to en-US unless a call site passes an explicit locale (e.g. budget.html's
  // app-locale-driven formatCurrency). The one literal per code lives here.
  var DEFAULT_LOCALE = 'en-US';
  var LOCALE_BY_CURRENCY = {
    BRL: 'pt-BR',
    MXN: 'es-MX',
    COP: 'es-CO',
  };

  // Intl renders both pesos with a bare '$' in their own locale, indistinguishable from USD, so their
  // currency part is swapped for the prefixed symbol (the same one the seed stores) while the locale's
  // digit grouping stays. Keep in sync with diplomat/db/seed/currencies.ts (a unit test pins it).
  var SYMBOL_BY_CURRENCY = {
    MXN: 'MX$',
    COP: 'COL$',
  };

  function formatIso(loc, code, amount) {
    var formatter = new Intl.NumberFormat(loc, { style: 'currency', currency: code });
    var symbol = SYMBOL_BY_CURRENCY[code];
    if (!symbol) return formatter.format(amount);
    return formatter
      .formatToParts(amount)
      .map(function (part) { return part.type === 'currency' ? symbol : part.value; })
      .join('');
  }

  function defaultLocale(code) {
    return LOCALE_BY_CURRENCY[code] || DEFAULT_LOCALE;
  }

  window.formatMoney = function (value, currencyCode, opts) {
    opts = opts || {};
    var amount = Number(value) || 0;
    var loc = opts.locale || defaultLocale(currencyCode);
    if (isIsoCurrency(currencyCode)) {
      return formatIso(loc, currencyCode, amount);
    }
    var meta = metaFor(currencyCode);
    var decimals = meta ? meta.decimals : 2;
    var symbol = meta ? meta.symbol : currencyCode;
    var numStr = new Intl.NumberFormat(loc, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
    return symbol + ' ' + numStr;
  };

  // Currency-map arithmetic shared across dashboard fragments (issue #174) — every fragment that
  // aggregates transactions keeps its own accumulator as a {currency: amount} map instead of a
  // single blended scalar (docs/architecture.md: aggregations group per currency, never convert
  // implicitly). These are locale-independent map operations (addMultiCurrency intentionally
  // mutates its `map` argument in place — an accumulator, not a pure function — the rest don't
  // mutate their inputs), so they live here instead of being copy-pasted into every fragment; each
  // fragment still owns its own thin formatCurrency/formatMultiCurrency wrapper locally because
  // those need the fragment's own resolved UI locale (e.g. budget.html's currentLocale), which this
  // shell-loaded, load-once module has no access to.
  window.DEFAULT_CURRENCY = BRL;

  window.addMultiCurrency = function (map, currency, amount) {
    var c = currency || window.DEFAULT_CURRENCY;
    map[c] = (map[c] || 0) + (Number(amount) || 0);
  };

  window.valueIn = function (map, currency) {
    return (map && map[currency]) || 0;
  };

  // Multi-currency amounts are never converted or summed together — a single number (a KPI, a
  // percentage, a chart value) can only ever read ONE real currency's own amount, never a
  // blended/converted total. This picks which currency represents a row/cell for such comparisons.
  window.primaryCurrencyOf = function (map) {
    var keys = Object.keys(map || {}).filter(function (c) { return map[c]; });
    if (keys.length === 0) keys = Object.keys(map || {});
    if (keys.indexOf(window.DEFAULT_CURRENCY) !== -1) return window.DEFAULT_CURRENCY;
    keys.sort();
    return keys[0] || window.DEFAULT_CURRENCY;
  };

  // Row/category sort order or "any activity" flag only, never a number shown to the user — a
  // plain sum of raw units across currencies (deliberately not a currency conversion).
  window.magnitudeOf = function (map) {
    return Object.keys(map || {}).reduce(function (sum, c) { return sum + (Number(map[c]) || 0); }, 0);
  };

  // Additively merges any number of currency maps — Object.assign/spread would silently overwrite
  // a currency present in more than one map instead of summing it (e.g. a category with both BRL
  // effective and BRL pending amounts would lose one of the two).
  window.mergeCurrencyMaps = function () {
    var maps = Array.prototype.slice.call(arguments);
    var result = {};
    maps.forEach(function (map) {
      Object.keys(map || {}).forEach(function (c) { window.addMultiCurrency(result, c, map[c]); });
    });
    return result;
  };

  // Renders every currency in a map side by side — never a single blended number — via the
  // caller-supplied formatFn (each fragment passes its own locale-aware formatCurrency, which this
  // shell-loaded, load-once module has no access to itself). A currency is skipped only when a
  // real (non-zero) currency is ALSO present in the map: an all-zero map (e.g. a USD-only month
  // whose income and expense net to exactly zero) still names its real currencies rather than
  // falling through to the DEFAULT_CURRENCY zero fallback, which would silently relabel that USD
  // zero as BRL — only a genuinely empty map (no keys at all) uses the DEFAULT_CURRENCY fallback.
  window.formatMultiCurrencyWith = function (map, formatFn, delimiter) {
    delimiter = delimiter || ' / ';
    if (!map || Object.keys(map).length === 0) return formatFn(0, window.DEFAULT_CURRENCY);
    var keys = Object.keys(map).sort(function (a, b) {
      if (a === window.DEFAULT_CURRENCY) return -1;
      if (b === window.DEFAULT_CURRENCY) return 1;
      return a.localeCompare(b);
    });
    var nonZeroKeys = keys.filter(function (c) { return map[c]; });
    var keysToShow = nonZeroKeys.length > 0 ? nonZeroKeys : keys;
    return keysToShow.map(function (c) { return formatFn(map[c], c); }).join(delimiter);
  };
})();
