import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CURRENCIES } from '../../../src/diplomat/db/seed/currencies.js';

// Loads a real dashboard fragment's <script> next to the real ui/money.js in a node:vm sandbox with
// a permissive DOM stub (every element answers every lookup), the way the other test/unit/ui suites
// do — the fragment is a browser-global script with no module system, so this is the only way to
// run the deployed code instead of a re-implementation.
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));
const dashboardPath = (name: string) => fileURLToPath(new URL(`../../../ui/dashboards/${name}.html`, import.meta.url));

type Listener = (event: { target: StubElement }) => void;

export type StubElement = {
  innerHTML: string;
  textContent: string;
  value: string;
  className: string;
  style: { display?: string; color?: string; setProperty: () => void };
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  children: StubElement[];
  options: never[];
  appendChild: (child: StubElement) => void;
  addEventListener: (type: string, handler: Listener) => void;
  fireEvent: (type: string) => void;
  querySelector: () => StubElement;
  querySelectorAll: () => never[];
  closest: () => StubElement;
  getContext: () => Record<string, unknown>;
  setAttribute: () => void;
  getAttribute: () => string | null;
  reset: () => void;
  [key: string]: unknown;
};

export const makeStubElement = (): StubElement => {
  const listeners: Record<string, Listener[]> = {};
  const el: StubElement = {
    innerHTML: '',
    textContent: '',
    value: '',
    className: '',
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    options: [],
    appendChild(child) {
      el.children.push(child);
      el.innerHTML += child.innerHTML;
    },
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    fireEvent(type) {
      (listeners[type] ?? []).forEach((handler) => handler({ target: el }));
    },
    querySelector: () => makeStubElement(),
    querySelectorAll: () => [],
    closest: () => makeStubElement(),
    getContext: () => ({}),
    setAttribute() {},
    getAttribute: () => null,
    reset() {},
  };
  return el;
};

const makeStubDocument = () => {
  const elements = new Map<string, StubElement>();
  return {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, makeStubElement());
      return elements.get(id) as StubElement;
    },
    createElement: () => makeStubElement(),
    addEventListener() {},
    querySelector: () => makeStubElement(),
    querySelectorAll: () => [],
    title: '',
  };
};

export const currencyMetadata = Object.fromEntries(CURRENCIES.map((currency) => [currency.code, currency]));

export type FragmentSandbox = {
  // A browser-global script's top-level names, read and driven by the tests.
  sandbox: Record<string, any>;
  document: ReturnType<typeof makeStubDocument>;
  charts: { type: string; data: { labels: string[]; datasets: { data: number[]; label?: string }[] } }[];
};

export const loadFragment = (
  name: string,
  { baseCurrency }: { baseCurrency?: string } = {},
): FragmentSandbox => {
  const document = makeStubDocument();
  const charts: FragmentSandbox['charts'] = [];
  const sandbox: Record<string, unknown> = {
    document,
    console: { ...console, log() {} },
    Date, Math, Number, String, Array, JSON, Set, Map, Promise, RegExp, Object,
    parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams, Intl,
    setTimeout, clearTimeout,
    fetch: () => new Promise(() => {}),
    flatpickr() {},
    MutationObserver: class { observe() {} },
    Chart: class {
      constructor(_ctx: unknown, config: FragmentSandbox['charts'][number]) {
        charts.push(config);
      }
      destroy() {}
    },
  };
  sandbox.window = sandbox;
  sandbox.location = { pathname: `/ui/${name}`, search: '' };
  sandbox.history = { pushState() {} };
  sandbox.__appCurrencies = currencyMetadata;

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MONEY_JS_PATH, 'utf-8'), sandbox, { filename: MONEY_JS_PATH });
  if (baseCurrency) (sandbox.setBaseCurrency as (code: string) => void)(baseCurrency);

  const html = readFileSync(dashboardPath(name), 'utf-8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  vm.runInContext(script, sandbox, { filename: dashboardPath(name) });
  return { sandbox, document, charts };
};
