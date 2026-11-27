import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { currencyMetadata, makeStubElement } from './fragment-sandbox.js';

// ui/app.js is a browser-global IIFE; its boot sequence is run in node:vm with a stubbed fetch to
// check that DEFAULT_CURRENCY follows /api/preferences before any dashboard loads.
const UI_DIR = '../../../ui/';
const read = (file: string) => readFileSync(fileURLToPath(new URL(UI_DIR + file, import.meta.url)), 'utf-8');

type Routes = Record<string, () => unknown>;

const bootShell = async (
  routes: Routes,
  { demo = false, chart, theme = {} }: { demo?: boolean; chart?: unknown; theme?: Record<string, string> } = {},
) => {
  let onReady: (() => void) | undefined;
  const loaded: string[] = [];
  const windowHandlers: Record<string, () => void> = {};
  const activeLinks: string[] = [];
  const titles: string[] = [];
  const stream: { onmessage?: (event: { data: string }) => void } = {};
  const respond = (url: string) => {
    const path = url.split('?')[0] ?? '';
    const handler = routes[path];
    if (path.startsWith('/api/dashboards/')) loaded.push(path);
    if (!handler) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    try {
      const body = handler();
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    } catch {
      return Promise.resolve({ ok: false, statusText: 'boom', json: () => Promise.reject(new Error('no body')) });
    }
  };
  const markedDemo = (name: string) => (demo && name === 'data-instance-kind' ? 'demo' : null);
  const body = { ...makeStubElement(), getAttribute: markedDemo };
  const document = {
    title: '',
    getElementById: () => makeStubElement(),
    querySelector: () => makeStubElement(),
    querySelectorAll: () => [],
    createElement: () => {
      let href = '';
      const el = makeStubElement();
      return Object.assign(el, {
        setAttribute(key: string, value: string) {
          if (key === 'href') href = value;
          if (key === 'title') titles.push(value);
        },
        classList: { ...el.classList, add: () => activeLinks.push(href) },
      });
    },
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'DOMContentLoaded') onReady = handler;
    },
    body,
    documentElement: { lang: 'en' },
  };
  const sandbox: Record<string, unknown> = {
    document,
    console: { ...console, error() {} },
    fetch: respond,
    Intl,
    Number,
    Object,
    Math,
    Array,
    Promise,
    Date,
    String,
    JSON,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    EventSource: class {
      constructor() {
        return stream;
      }
    },
    location: { pathname: '/ui/overview', search: '' },
    history: { pushState() {} },
    addEventListener: (type: string, handler: () => void) => {
      windowHandlers[type] = handler;
    },
    Chart: chart,
    getComputedStyle: () => ({ getPropertyValue: (name: string) => theme[name] ?? '' }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('money.js'), sandbox);
  vm.runInContext(read('app.js'), sandbox);
  onReady?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { sandbox, loaded, stream, document, windowHandlers, activeLinks, titles };
};

const currencies = Object.values(currencyMetadata);

describe('shell boot (ui/app.js)', () => {
  it('sets DEFAULT_CURRENCY from the user base currency before loading a dashboard', async () => {
    const { sandbox, loaded } = await bootShell({
      '/api/currencies': () => currencies,
      '/api/preferences': () => ({ baseCurrency: 'COP' }),
    });
    expect(sandbox.DEFAULT_CURRENCY).toBe('COP');
    expect(sandbox.BASE_CURRENCY).toBe('COP');
    expect(loaded.length).toBeGreaterThan(0);
  });

  it('ignores a base currency the instance does not know', async () => {
    const { sandbox } = await bootShell({
      '/api/currencies': () => currencies,
      '/api/preferences': () => ({ baseCurrency: 'XYZ' }),
    });
    expect(sandbox.DEFAULT_CURRENCY).toBe('BRL');
  });

  it('keeps the default and still loads the dashboard when /api/preferences fails', async () => {
    const { sandbox, loaded } = await bootShell({
      '/api/currencies': () => currencies,
      '/api/preferences': () => {
        throw new Error('down');
      },
    });
    expect(sandbox.DEFAULT_CURRENCY).toBe('BRL');
    expect(loaded.length).toBeGreaterThan(0);
  });

  it('refreshes the default on a userSettings event before the fragment is told', async () => {
    let base = 'USD';
    const { sandbox, stream } = await bootShell({
      '/api/currencies': () => currencies,
      '/api/preferences': () => ({ baseCurrency: base }),
    });
    const seen: string[] = [];
    sandbox.onAppDataChanged = () => seen.push(sandbox.DEFAULT_CURRENCY as string);
    base = 'MXN';
    stream.onmessage?.({ data: JSON.stringify({ entities: ['userSettings'] }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(['MXN']);
  });

  describe('a userSettings event', () => {
    const settingsEvent = { data: JSON.stringify({ entities: ['userSettings'] }) };
    const bootWith = (state: { locale: string; base: string }) =>
      bootShell({
        '/api/dashboards': () => [{ name: 'overview', source: 'file' }],
        '/api/currencies': () => currencies,
        '/api/status': () => ({ locale: state.locale }),
        '/api/preferences': () => ({ baseCurrency: state.base }),
        '/api/dashboards/overview': () => ({ name: 'Overview', html: '<p>ok</p>' }),
      });

    it('reloads the dashboard once, without forwarding the event, when the language changed', async () => {
      const state = { locale: 'en', base: 'USD' };
      const { sandbox, stream, loaded } = await bootWith(state);
      const forwarded: string[][] = [];
      sandbox.onAppDataChanged = (entities: string[]) => forwarded.push(entities);
      const loadsBefore = loaded.length;

      state.locale = 'pt';
      stream.onmessage?.(settingsEvent);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(loaded.length - loadsBefore).toBe(1);
      expect(forwarded).toEqual([]);
    });

    it('redraws the sidebar in the new language and keeps the active dashboard', async () => {
      const state = { locale: 'en', base: 'USD' };
      const { stream, titles, activeLinks } = await bootWith(state);
      expect(titles).toEqual(['Overview']);

      state.locale = 'pt';
      stream.onmessage?.(settingsEvent);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(titles).toHaveLength(2);
      expect(titles[1]).not.toBe('Overview');
      expect(activeLinks).toEqual(['/ui/overview', '/ui/overview']);
    });

    it('forwards a base-currency change without reloading the dashboard', async () => {
      const state = { locale: 'en', base: 'USD' };
      const { sandbox, stream, loaded } = await bootWith(state);
      const forwarded: string[][] = [];
      sandbox.onAppDataChanged = (entities: string[]) => forwarded.push(entities);
      const loadsBefore = loaded.length;

      state.base = 'MXN';
      stream.onmessage?.(settingsEvent);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(loaded.length).toBe(loadsBefore);
      expect(forwarded).toEqual([['userSettings']]);
    });
  });

  describe('document title', () => {
    const overview = { '/api/dashboards/overview': () => ({ name: 'Overview', html: '<p>ok</p>' }) };

    it('is "PATTY — <dashboard>" once the dashboard has rendered', async () => {
      const { document } = await bootShell(overview);
      expect(document.title).toBe('PATTY — Overview');
    });

    it('starts with [Demo] when the server marked the page as a demo', async () => {
      const { document } = await bootShell(overview, { demo: true });
      expect(document.title).toBe('[Demo] PATTY — Overview');
    });
  });

  describe('UI language', () => {
    const statusFor = (locale: string) => ({ '/api/status': () => ({ locale }) });
    const page = (sandbox: Record<string, unknown>) =>
      sandbox.PATTY as {
        locale: string;
        formatMoney: (v: number, c: string) => string;
        formatDate: (v: string) => string;
        formatNumber: (v: number) => string;
        formatDateTime: (v: Date) => string;
      };

    it.each([
      ['pt', 'pt-BR'],
      ['es', 'es'],
      ['en', 'en-US'],
    ])('sets <html lang> and PATTY.locale for %s to %s', async (locale, tag) => {
      const { sandbox, document } = await bootShell(statusFor(locale));
      expect(document.documentElement.lang).toBe(tag);
      expect(page(sandbox).locale).toBe(tag);
    });

    it('reads the Chart.js defaults from the CSS theme variables', async () => {
      const defaults = { font: {}, plugins: { legend: { labels: {} } } } as Record<string, any>;
      const theme = { '--text-muted': ' #111111 ', '--chart-grid': 'rgba(1, 2, 3, 0.1)', '--font-family': 'Test Sans' };
      await bootShell(statusFor('en'), { chart: { defaults }, theme });
      expect(defaults.color).toBe('#111111');
      expect(defaults.plugins.legend.labels.color).toBe('#111111');
      expect(defaults.borderColor).toBe('rgba(1, 2, 3, 0.1)');
      expect(defaults.font.family).toBe('Test Sans');
    });

    it('leaves Chart.js defaults alone for a variable the theme does not define', async () => {
      const defaults = { color: 'keep', font: {}, plugins: { legend: { labels: {} } } } as Record<string, any>;
      await bootShell(statusFor('en'), { chart: { defaults } });
      expect(defaults.color).toBe('keep');
    });

    describe('a missing value is never shown as 0', () => {
      const missing = [null, undefined, Number.NaN];
      const formatters = (patty: ReturnType<typeof page>) => ({
        formatMoney: (value: unknown) => patty.formatMoney(value as number, 'USD'),
        formatNumber: (value: unknown) => patty.formatNumber(value as number),
        formatDate: (value: unknown) => patty.formatDate(value as string),
        formatDateTime: (value: unknown) => patty.formatDateTime(value as Date),
      });

      it.each(['formatMoney', 'formatNumber', 'formatDate', 'formatDateTime'] as const)(
        '%s renders null, undefined and NaN as the empty value',
        async (name) => {
          const { sandbox } = await bootShell({ ...statusFor('en'), '/api/currencies': () => currencies });
          const format = formatters(page(sandbox))[name];
          expect(missing.map(format)).toEqual(['—', '—', '—']);
        },
      );

      it('still formats a real zero', async () => {
        const { sandbox } = await bootShell({ ...statusFor('en'), '/api/currencies': () => currencies });
        expect(page(sandbox).formatNumber(0)).toBe('0');
        expect(page(sandbox).formatMoney(0, 'USD')).toBe('$0.00');
      });

      it('formatDate renders an invalid date as the empty value', async () => {
        const { sandbox } = await bootShell(statusFor('en'));
        expect(page(sandbox).formatDate('not-a-date')).toBe('—');
      });
    });

    it('exposes the base currency, kept in step with the setting', async () => {
      const { sandbox } = await bootShell({
        ...statusFor('en'),
        '/api/currencies': () => currencies,
        '/api/preferences': () => ({ baseCurrency: 'COP' }),
      });
      expect((sandbox.PATTY as { baseCurrency: string }).baseCurrency).toBe('COP');
    });

    it('formats with component options instead of throwing on the style defaults', async () => {
      const { sandbox } = await bootShell(statusFor('en'));
      const patty = sandbox.PATTY as {
        formatDate: (v: string, o?: object) => string;
        formatDateTime: (v: Date, o?: object) => string;
      };
      expect(patty.formatDate('2026-03-05', { year: 'numeric', month: 'short' })).toBe('Mar 2026');
      expect(
        patty.formatDateTime(new Date(Date.UTC(2026, 2, 5, 15, 4)), {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC',
          hour12: false,
        }),
      ).toBe('15:04');
    });

    it('keeps the date and time styles when only non-component options are passed', async () => {
      const { sandbox } = await bootShell(statusFor('en'));
      const patty = sandbox.PATTY as { formatDateTime: (v: Date, o?: object) => string };
      expect(patty.formatDateTime(new Date(Date.UTC(2026, 2, 5, 15, 4)), { timeZone: 'UTC' })).toMatch(
        /^Mar 5, 2026, 3:04\s?PM$/,
      );
    });

    it('follows a locale change on a userSettings event, for a reference the fragment already holds', async () => {
      let locale = 'en';
      const { sandbox, stream, document } = await bootShell({ '/api/status': () => ({ locale }) });
      const held = sandbox.PATTY as { locale: string; formatNumber: (v: number) => string };
      const { formatNumber } = held;
      expect(formatNumber(1234.5)).toBe('1,234.5');
      locale = 'pt';
      stream.onmessage?.({ data: JSON.stringify({ entities: ['userSettings'] }) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(held.locale).toBe('pt-BR');
      expect(document.documentElement.lang).toBe('pt-BR');
      expect(formatNumber(1234.5)).toBe('1.234,5');
    });

    it('applies overlapping userSettings refreshes in event order, reloading after each language change', async () => {
      const replies: Array<(value: { locale: string }) => void> = [];
      const languageAtLoad: string[] = [];
      let calls = 0;
      const page: { documentElement?: { lang: string } } = {};
      const { sandbox, stream, document } = await bootShell({
        '/api/status': () =>
          ++calls === 1
            ? { locale: 'en' }
            : new Promise<{ locale: string }>((resolve) => {
                replies.push(resolve);
              }),
        '/api/dashboards/overview': () => {
          languageAtLoad.push(page.documentElement?.lang ?? '');
          return { name: 'Overview', html: '<p>ok</p>' };
        },
      });
      page.documentElement = document.documentElement;
      const forwarded: string[][] = [];
      sandbox.onAppDataChanged = (entities: string[]) => forwarded.push(entities);
      languageAtLoad.length = 0;
      const event = { data: JSON.stringify({ entities: ['userSettings'] }) };
      stream.onmessage?.(event);
      stream.onmessage?.(event);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(replies).toHaveLength(1);
      replies[0]?.({ locale: 'pt' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(replies).toHaveLength(2);
      replies[1]?.({ locale: 'es' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(languageAtLoad).toEqual(['pt-BR', 'es']);
      expect(forwarded).toEqual([]);
      expect(document.documentElement.lang).toBe('es');
    });

    it('falls back to the default currency when no base currency resolved', async () => {
      const { sandbox } = await bootShell({
        ...statusFor('en'),
        '/api/preferences': () => {
          throw new Error('down');
        },
      });
      expect((sandbox.PATTY as { baseCurrency: string }).baseCurrency).toBe('BRL');
    });

    it('loads and activates the dashboard the URL names once ready when history moved during boot', async () => {
      let release: () => void = () => {};
      const gate = new Promise<{ locale: string }>((resolve) => {
        release = () => resolve({ locale: 'en' });
      });
      const { sandbox, loaded, windowHandlers, activeLinks } = await bootShell({
        '/api/status': () => gate,
        '/api/dashboards': () => [
          { name: 'overview', source: 'file' },
          { name: 'pending', source: 'file' },
        ],
      });
      (sandbox.location as { pathname: string }).pathname = '/ui/pending';
      windowHandlers.popstate?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(loaded).toEqual([]);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(loaded).toEqual(['/api/dashboards/pending']);
      expect(activeLinks).toEqual(['/ui/pending']);
    });

    it('lets only the latest dashboard load render', async () => {
      const replies: Record<string, (value: { name: string; html: string }) => void> = {};
      const { sandbox, document, windowHandlers } = await bootShell({
        ...statusFor('en'),
        '/api/dashboards/overview': () => ({ name: 'Overview', html: '<p>o</p>' }),
        '/api/dashboards/budget': () =>
          new Promise((resolve) => {
            replies.budget = resolve;
          }),
        '/api/dashboards/pending': () => ({ name: 'Pending', html: '<p>p</p>' }),
      });
      const location = sandbox.location as { pathname: string };
      location.pathname = '/ui/budget';
      windowHandlers.popstate?.();
      location.pathname = '/ui/pending';
      windowHandlers.popstate?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      replies.budget?.({ name: 'Budget', html: '<p>b</p>' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.title).toBe('PATTY — Pending');
    });

    it('falls back to en-US when /api/status fails', async () => {
      const { sandbox } = await bootShell({
        '/api/status': () => {
          throw new Error('down');
        },
      });
      expect(page(sandbox).locale).toBe('en-US');
    });

    it('formats money, numbers and dates in pt-BR for pt', async () => {
      const { sandbox } = await bootShell({ ...statusFor('pt'), '/api/currencies': () => currencies });
      const patty = page(sandbox);
      expect(patty.formatMoney(1234.5, 'USD')).toBe('US$\u00a01.234,50');
      expect(patty.formatNumber(1234.5)).toBe('1.234,5');
      expect(patty.formatDate('2026-03-05')).toBe('5 de mar. de 2026');
      expect(patty.formatDateTime(new Date(Date.UTC(2026, 2, 5, 12, 0)))).toContain('2026');
    });

    it('keeps the crypto-aware precision of money.js', async () => {
      const { sandbox } = await bootShell({ ...statusFor('pt'), '/api/currencies': () => currencies });
      expect(page(sandbox).formatMoney(0.12345678, 'BTC')).toContain('0,12345678');
    });
  });
});
