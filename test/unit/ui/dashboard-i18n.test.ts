import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFragment } from './fragment-sandbox.js';

const DASHBOARDS_DIR = fileURLToPath(new URL('../../../ui/dashboards/', import.meta.url));
const dashboardSource = (name: string) => readFileSync(`${DASHBOARDS_DIR}${name}.html`, 'utf-8');
const DASHBOARDS = readdirSync(DASHBOARDS_DIR)
  .filter((file) => file.endsWith('.html'))
  .map((file) => file.replace(/\.html$/, ''));

// Dashboards that still carry hard-coded text. The list only shrinks: a dashboard that passes the guard must be
// removed from it (the test below fails until it is), and a new dashboard never joins it.
const NOT_YET_TRANSLATED = [
  'accounts',
  'budget',
  'categories',
  'comparative',
  'dashboards',
  'overview',
  'pending',
  'projections',
  'tags',
];

// Category names the backend seeds; they are data keys of a lookup, not text the page shows.
const SEEDED_DATA_KEYS = ['Educação', 'Saúde', 'Empréstimos p/ Terc'];

const TABLE_START = 'var TRANSLATIONS = {';
const TABLE_END = '\n};\n';
const LETTER = /\p{L}/u;
const PORTUGUESE_ACCENT = /[áàâãéêíóôõúçÁÂÃÉÊÍÓÔÕÚÇ]/;
const PORTUGUESE_WORD =
  /\b(Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro|Jan|Fev|Abr|Ago|Dez|Selecionar|Cartão|Cartões|Fatura|Faturas|Lançamento|Lançamentos|Descrição|Categoria|Valor|Passada|Atual|Futura|Nenhum|Nenhuma|Erro|Salvar|Cancelar|Adicionar|Excluir|Confirmar|Limite|Pagar|Pago|Paga|Aberta|Fechada|Pagamento|Observação|Reverter|Restante)\b/;
const TRANSLATABLE_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source']);
const CALL_SITES = /\b(showToast|confirm|alert)\(/g;
const ASSIGNMENT_SITES = /\.(textContent|innerHTML|placeholder|title)\s*\+?=\s*(?=['"`])/g;
const OPEN_QUOTES = new Set(["'", '"', '`']);

const withoutComments = (text: string) =>
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

const withoutTable = (source: string) => {
  const start = source.indexOf(TABLE_START);
  const end = source.indexOf(TABLE_END, start);
  return start === -1 ? source : source.slice(0, start) + source.slice(end + TABLE_END.length);
};

// Drops every ${…} expression of a template (nested braces and templates included), leaving the literal text.
const withoutInterpolations = (template: string) => {
  const kept: string[] = [];
  let depth = 0;
  for (let i = 0; i < template.length; i += 1) {
    if (depth === 0 && template[i] === '$' && template[i + 1] === '{') {
      depth = 1;
      i += 1;
    } else if (depth > 0) {
      depth += template[i] === '{' ? 1 : template[i] === '}' ? -1 : 0;
    } else {
      kept.push(template.charAt(i));
    }
  }
  return kept.join('');
};

// The literal starting at `from` (a quote or backtick), with its interpolations removed.
const literalAt = (text: string, from: number) => {
  const quote = text[from];
  let end = from + 1;
  let depth = 0;
  while (end < text.length && !(depth === 0 && text[end] === quote)) {
    if (quote === '`' && text[end] === '$' && text[end + 1] === '{') depth += 1;
    else if (depth > 0 && text[end] === '}') depth -= 1;
    else if (text[end] === '\\') end += 1;
    end += 1;
  }
  return withoutInterpolations(text.slice(from + 1, end));
};

const visibleText = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\{[\w-]+\}/g, ' ');

const hasLetters = (text: string) => LETTER.test(visibleText(text));

const attributeViolations = (tag: string, attributes: string) =>
  TRANSLATABLE_ATTRIBUTES.filter((name) => {
    const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
    return value !== undefined && hasLetters(value) && !attributes.includes(`data-i18n-${name}`);
  }).map((name) => `<${tag}> ${name} outside the table`);

const markupViolations = (html: string) => {
  const markup = withoutComments(html).replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  const covered: boolean[] = [];
  const found: string[] = [];
  for (const [, closing, tag = '', attributes = '', text] of markup.matchAll(
    /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g,
  )) {
    if (text !== undefined) {
      if (hasLetters(text) && !covered.at(-1)) found.push(`text "${text.trim().slice(0, 50)}" outside the table`);
    } else if (closing) {
      covered.pop();
    } else {
      found.push(...attributeViolations(tag, attributes));
      if (!VOID_TAGS.has(tag) && !attributes.endsWith('/'))
        covered.push(Boolean(covered.at(-1)) || attributes.includes('data-i18n='));
    }
  }
  return found;
};

const scriptViolations = (source: string) => {
  const script = withoutComments(withoutTable(source)).match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const calls = [...script.matchAll(CALL_SITES)]
    .map((match) => match.index + match[0].length)
    .filter((at) => OPEN_QUOTES.has(script.charAt(at)))
    .map((at) => ({ site: 'call argument', text: literalAt(script, at) }));
  const assignments = [...script.matchAll(ASSIGNMENT_SITES)].map((match) => ({
    site: match[1],
    text: literalAt(script, match.index + match[0].length),
  }));
  return [...calls, ...assignments]
    .filter(({ text }) => hasLetters(text))
    .map(({ site, text }) => `${site} "${visibleText(text).trim().slice(0, 50)}" outside the table`);
};

const portugueseViolations = (source: string) => {
  const outside = SEEDED_DATA_KEYS.reduce(
    (text, key) => text.replaceAll(key, ''),
    withoutComments(withoutTable(source))
      .replace(/<[^>]*\sdata-i18n-(?:placeholder|title)="[^>]*>/g, ' ')
      .replace(/\sdata-i18n="[^"]*"[^>]*>[^<]*/g, ' '),
  );
  return outside
    .split('\n')
    .flatMap((line, index) =>
      PORTUGUESE_ACCENT.test(line) || PORTUGUESE_WORD.test(line)
        ? [`line ${index + 1} holds Portuguese: ${line.trim().slice(0, 60)}`]
        : [],
    );
};

const violationsOf = (name: string) => {
  const source = dashboardSource(name);
  return [...markupViolations(withoutTable(source)), ...scriptViolations(source), ...portugueseViolations(source)];
};

describe('bundled dashboards take their text from the i18n table', () => {
  it('lists only dashboards that exist', () => {
    expect(NOT_YET_TRANSLATED.filter((name) => !DASHBOARDS.includes(name))).toEqual([]);
  });

  it.each(DASHBOARDS.filter((name) => !NOT_YET_TRANSLATED.includes(name)))('%s has no hard-coded text', (name) => {
    expect(violationsOf(name)).toEqual([]);
  });

  it.each(NOT_YET_TRANSLATED)(
    '%s still has hard-coded text, so it stays on the list (remove it once it passes)',
    (name) => {
      expect(violationsOf(name).length).toBeGreaterThan(0);
    },
  );
});

describe('the guard catches hard-coded text', () => {
  it('flags element text, attributes, option text and call-site literals, and accepts table-driven text', () => {
    expect(markupViolations('<div><span>Salvar</span><input placeholder="Ex: casa"></div>')).toHaveLength(2);
    expect(markupViolations('<select><option value="1">Janeiro</option></select>')).toHaveLength(1);
    expect(markupViolations('<label data-i18n="k"><i></i> Salvar</label><input placeholder="0,00">')).toEqual([]);
    expect(markupViolations('<input data-i18n-placeholder="k" placeholder="Ex: casa">')).toEqual([]);
    expect(scriptViolations('<script>showToast("Erro ao salvar", "error")</script>')).toHaveLength(1);
    expect(scriptViolations('<script>el.innerHTML = `<b>Total</b> ${x}`;</script>')).toHaveLength(1);
    expect(
      scriptViolations("<script>showToast(t('k'), 'error'); el.textContent = `${t('k')} (${n})`;</script>"),
    ).toEqual([]);
    expect(portugueseViolations('<script>const label = cond ? `${a}` : `${count} lançamentos`;</script>')).toHaveLength(
      1,
    );
  });
});

describe('cards.html follows the PATTY language', () => {
  // The shell's window.PATTY.locale tag and the table key the fragment maps it to.
  const LANGUAGES = [
    ['en-US', 'en'],
    ['pt-BR', 'pt'],
    ['es', 'es'],
  ] as const;
  const keyOf = (pattern: RegExp) => pattern.exec(dashboardSource('cards'))?.[1] as string;
  const HEADER_KEY = keyOf(/<h1>[\s\S]*?data-i18n="([\w]+)"/);
  const FORM_LABEL_KEY = keyOf(/<label for="add-desc" data-i18n="([\w]+)"/);
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const toastIn = async (tag: string) => {
    const { sandbox, document } = loadFragment('cards', { locale: tag });
    sandbox.fetch = () => Promise.reject(new Error('offline'));
    await sandbox.fetchInitialData();
    return document.getElementById('toast-box').innerHTML as string;
  };

  const deleteConfirmationIn = async (tag: string) => {
    const { sandbox } = loadFragment('cards', { locale: tag });
    const asked: string[] = [];
    sandbox.confirm = (message: string) => (asked.push(message), false);
    await sandbox.deleteTx('tx-1', 'Coffee');
    return asked[0] as string;
  };

  it('ships en, pt and es entries for every key the page asks for', () => {
    const { sandbox } = loadFragment('cards');
    const keys = new Set([
      ...[...dashboardSource('cards').matchAll(/data-i18n(?:-placeholder)?="(\w+)"/g)].map((match) => match[1]),
      ...[...dashboardSource('cards').matchAll(/\bt(?:Fill)?\('(\w+)'/g)].map((match) => match[1]),
    ]);
    const missing = ['en', 'pt', 'es'].flatMap((locale) =>
      [...keys]
        .filter((key): key is string => key !== undefined && !(key in sandbox.TRANSLATIONS[locale]))
        .map((key) => `${locale}.${key}`),
    );
    expect(missing).toEqual([]);
  });

  it('has no in-place refresh logic: the shell reloads the dashboard on a language change', () => {
    const source = withoutComments(dashboardSource('cards'));
    expect(source).not.toMatch(/checkLocale|refreshLocale|dataLocale|localeRequest|\/api\/status/);
  });

  it('falls back to English when the shell gives no language', () => {
    expect(loadFragment('cards').sandbox.currentLocale).toBe('en');
  });

  it.each(LANGUAGES)('renders in the language of window.PATTY.locale %s', async (tag, key) => {
    const { sandbox } = loadFragment('cards', { locale: tag });
    const table = sandbox.TRANSLATIONS[key];
    expect(sandbox.currentLocale).toBe(key);
    expect(sandbox.t(HEADER_KEY)).toBe(table[HEADER_KEY]);
    expect(sandbox.t(FORM_LABEL_KEY)).toBe(table[FORM_LABEL_KEY]);
    expect(await toastIn(tag)).toContain(table.toast_load_error);
    expect(await deleteConfirmationIn(tag)).toBe(table.confirm_delete_charge.replace('{description}', 'Coffee'));
  });

  it('words the header, a form label, a toast and the delete confirmation differently in each language', async () => {
    const [en, pt, es] = LANGUAGES.map(([tag]) => tag);
    const distinct = async (read: (tag: string) => Promise<string> | string) =>
      new Set(await Promise.all([en, pt, es].map((tag) => read(tag as string)))).size;
    expect(await distinct((tag) => loadFragment('cards', { locale: tag }).sandbox.t(HEADER_KEY))).toBe(3);
    expect(await distinct((tag) => loadFragment('cards', { locale: tag }).sandbox.t(FORM_LABEL_KEY))).toBe(3);
    expect(await distinct(toastIn)).toBe(3);
    expect(await distinct(deleteConfirmationIn)).toBe(3);
  });

  describe('text built from data', () => {
    const populated = () => {
      const { sandbox, document } = loadFragment('cards', { locale: 'en-US' });
      sandbox.activeCard = { id: 'card-1', name: 'Nubank', currency: 'BRL' };
      sandbox.currentBill = {
        bill: { status: 'open', payments: [] },
        total: 30,
        transactions: [
          {
            id: 'tx-1',
            description: 'Coffee',
            amount: 10,
            currency: 'BRL',
            type: 'expense',
            date: '2026-06-01',
            status: 'effective',
          },
          {
            id: 'tx-2',
            description: 'Payment',
            amount: 20,
            currency: 'BRL',
            type: 'income',
            date: '2026-06-02',
            status: 'effective',
          },
        ],
      };
      return { sandbox, document };
    };

    it('renders a populated bill and finds a payment by its translated category name', () => {
      const { sandbox, document } = populated();
      sandbox.renderTransactionsTable();
      expect(document.getElementById('items-2026-06-01').innerHTML).toContain('Uncategorized');
      expect(document.getElementById('items-2026-06-02').innerHTML).toContain('Payment');
      expect(document.getElementById('bill-txs-list').innerHTML).toContain('Tuesday');

      sandbox.searchTerm = 'payment';
      sandbox.renderTransactionsTable();
      expect(document.getElementById('no-tx-msg').style.display).toBe('none');

      sandbox.searchTerm = 'zzz';
      sandbox.renderTransactionsTable();
      expect(document.getElementById('no-tx-msg').innerHTML).toContain('No results found for &quot;zzz&quot;.');
    });

    it('keeps dollar-sign tokens of a description verbatim in the confirmation', async () => {
      const { sandbox } = loadFragment('cards', { locale: 'en-US' });
      const asked: string[] = [];
      sandbox.confirm = (message: string) => (asked.push(message), false);
      await sandbox.deleteTx('tx-1', 'Coffee $& $$');
      expect(asked[0]).toContain('"Coffee $& $$"');
    });

    it('drops a bill answer that arrives after another card was selected', async () => {
      const { sandbox } = loadFragment('cards', { locale: 'en-US' });
      const first = { id: 'card-1', name: 'Nubank', currency: 'BRL' };
      const second = { id: 'card-2', name: 'Visa', currency: 'BRL' };
      const totals = [later(20).then(() => 1), Promise.resolve(2)];
      sandbox.fetch = () =>
        (totals.shift() as Promise<number>).then((total) => ({
          ok: true,
          json: () => Promise.resolve({ bill: { status: 'open', payments: [] }, transactions: [], total }),
        }));
      sandbox.activeCard = first;
      const stale = sandbox.loadBillDetails();
      sandbox.activeCard = second;
      await sandbox.loadBillDetails();
      await stale;
      expect(sandbox.currentBill.total).toBe(2);
    });

    it('leaves a replacement fragment alone when an old request answers after the dashboard was reloaded', async () => {
      const { sandbox, supersede } = loadFragment('cards', { locale: 'pt-BR' });
      sandbox.categories = [];
      sandbox.fetch = (url: string) =>
        later(20).then(() => ({
          ok: true,
          json: () => Promise.resolve(url === '/api/categories' ? [{ id: 'cat-1', name: 'Comida' }] : []),
        }));
      const pending = sandbox.fetchInitialData();
      supersede();
      await pending;
      expect(sandbox.categories).toEqual([]);
    });

    it('shows no error and clears no loading indicator for a load that outlived its fragment', async () => {
      const { sandbox, document, supersede } = loadFragment('cards', { locale: 'en-US' });
      const cleared: string[] = [];
      sandbox.billLoading.classList.remove = () => cleared.push('bill');
      sandbox.txLoading.classList.remove = () => cleared.push('tx');
      sandbox.activeCard = { id: 'card-1', name: 'Nubank', currency: 'BRL' };
      sandbox.fetch = () => later(20).then(() => Promise.reject(new Error('offline')));

      const initial = sandbox.fetchInitialData();
      const bill = sandbox.loadBillDetails();
      supersede();
      await Promise.all([initial, bill]);

      expect(document.getElementById('toast-box').innerHTML).toBe('');
      expect(cleared).toEqual([]);
    });

    it('keeps the replacement cards when a card reload answers after the dashboard was reloaded', async () => {
      const { sandbox, supersede } = loadFragment('cards', { locale: 'en-US' });
      sandbox.creditCards = [];
      sandbox.fetch = () =>
        later(20).then(() => ({ ok: true, json: () => Promise.resolve([{ id: 'card-1', name: 'Nubank' }]) }));
      const pending = sandbox.loadCreditCards();
      supersede();
      await pending;
      expect(sandbox.creditCards).toEqual([]);
    });

    it('drops a bill answer that arrives after the month changed', async () => {
      const { sandbox, document } = loadFragment('cards', { locale: 'en-US' });
      sandbox.activeCard = { id: 'card-1', name: 'Nubank', currency: 'BRL' };
      const answers = [later(20).then(() => 1), Promise.resolve(2)];
      sandbox.fetch = () =>
        (answers.shift() as Promise<number>).then((total) => ({
          ok: true,
          json: () => Promise.resolve({ bill: { status: 'open', payments: [] }, transactions: [], total }),
        }));
      const stale = sandbox.loadBillDetails();
      document.getElementById('month-select').value = '8';
      await sandbox.loadBillDetails();
      await stale;
      expect(sandbox.currentBill.total).toBe(2);
    });

    it('reads anything but an integer month 1-12 as empty text', () => {
      const { sandbox } = loadFragment('cards', { locale: 'en-US' });
      expect([undefined, 0, 13, -1, 6.5, '6'].map((month) => sandbox.monthLabel(month))).toEqual([
        '',
        '',
        '',
        '',
        '',
        '',
      ]);
      expect(sandbox.monthLabel(6)).toBe('June');
      expect(loadFragment('cards', { locale: 'es' }).sandbox.monthLabel(6)).toBe('Junio');
    });
  });
});
