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

  var isoCurrencyCache = null;

  function isIsoCurrency(code) {
    if (typeof Intl.supportedValuesOf !== 'function') {
      // Pre-Enumeration-API engine (no modern evergreen browser lacks this) — best-effort via
      // throw/no-throw: correct for a malformed code like USDC, silently wrong precision for a
      // well-formed-but-unrecognized 3-letter code like BTC until the engine is updated.
      try {
        // eslint-disable-next-line no-new -- probing for a thrown RangeError is the whole point
        new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
        return true;
      } catch (e) {
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

  // Matches the per-fragment convention this replaces (isBRL/isUSD ? 'pt-BR' : 'en-US') — BRL
  // formats in its own market's digit grouping, everything else defaults to en-US unless a call
  // site passes an explicit locale (e.g. budget.html's app-locale-driven formatCurrency).
  function defaultLocale(code) {
    return code === 'BRL' ? 'pt-BR' : 'en-US';
  }

  window.formatMoney = function (value, currencyCode, opts) {
    opts = opts || {};
    var amount = Number(value) || 0;
    var loc = opts.locale || defaultLocale(currencyCode);
    if (isIsoCurrency(currencyCode)) {
      return new Intl.NumberFormat(loc, { style: 'currency', currency: currencyCode }).format(amount);
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
})();
