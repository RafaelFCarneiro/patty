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

const bootShell = async (routes: Routes, { demo = false }: { demo?: boolean } = {}) => {
  let onReady: (() => void) | undefined;
  const loaded: string[] = [];
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
    createElement: () => makeStubElement(),
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'DOMContentLoaded') onReady = handler;
    },
    body,
  };
  const sandbox: Record<string, unknown> = {
    document, console: { ...console, error() {} }, fetch: respond, Intl, Number, Object, Math, Array, Promise,
    Date, String, JSON, encodeURIComponent, setTimeout, clearTimeout, URLSearchParams,
    EventSource: class {
      constructor() {
        return stream;
      }
    },
    location: { pathname: '/ui/overview', search: '' },
    history: { pushState() {} },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('money.js'), sandbox);
  vm.runInContext(read('app.js'), sandbox);
  onReady?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { sandbox, loaded, stream, document };
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
});
