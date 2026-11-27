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
  const LOCALES = ['en', 'es'] as const;
  const keyOf = (pattern: RegExp) => pattern.exec(dashboardSource('cards'))?.[1] as string;
  const HEADER_KEY = keyOf(/<h1>[\s\S]*?data-i18n="([\w]+)"/);
  const FORM_LABEL_KEY = keyOf(/<label for="add-desc" data-i18n="([\w]+)"/);

  const translate = (locale: string, key: string) => {
    const { sandbox } = loadFragment('cards');
    sandbox.currentLocale = locale;
    return sandbox.t(key) as string;
  };

  const toastIn = async (locale: string) => {
    const { sandbox, document } = loadFragment('cards');
    sandbox.currentLocale = locale;
    sandbox.fetch = () => Promise.reject(new Error('offline'));
    await sandbox.fetchInitialData();
    return document.getElementById('toast-box').innerHTML as string;
  };

  const deleteConfirmationIn = async (locale: string) => {
    const { sandbox } = loadFragment('cards');
    const asked: string[] = [];
    sandbox.currentLocale = locale;
    sandbox.confirm = (message: string) => (asked.push(message), false);
    await sandbox.deleteTx('tx-1', 'Coffee');
    return asked[0];
  };

  it('ships en, pt and es entries for every key the page asks for', () => {
    const { sandbox } = loadFragment('cards');
    const keys = new Set([
      ...[...dashboardSource('cards').matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)].map((match) => match[1]),
      ...[...dashboardSource('cards').matchAll(/\bt(?:Fill)?\('(\w+)'/g)].map((match) => match[1]),
    ]);
    const missing = ['en', 'pt', 'es'].flatMap((locale) =>
      [...keys]
        .filter((key): key is string => key !== undefined && !(key in sandbox.TRANSLATIONS[locale]))
        .map((key) => `${locale}.${key}`),
    );
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)('translates the header, a form label, a toast and the delete confirmation to %s', async (locale) => {
    expect(translate(locale, HEADER_KEY)).not.toBe(translate('pt', HEADER_KEY));
    expect(translate(locale, FORM_LABEL_KEY)).not.toBe(translate('pt', FORM_LABEL_KEY));
    expect(await toastIn(locale)).not.toBe(await toastIn('pt'));
    const confirmation = await deleteConfirmationIn(locale);
    expect(confirmation).toContain('Coffee');
    expect(confirmation).not.toBe(await deleteConfirmationIn('pt'));
  });

  it('keeps the Portuguese wording for pt', async () => {
    expect(await toastIn('pt')).toContain('Erro ao carregar');
    expect(await deleteConfirmationIn('pt')).toContain('Deseja excluir');
  });
});

describe('cards.html text built from data', () => {
  const populated = () => {
    const { sandbox, document } = loadFragment('cards');
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
    sandbox.currentLocale = 'en';
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
    const { sandbox } = loadFragment('cards');
    const asked: string[] = [];
    sandbox.confirm = (message: string) => (asked.push(message), false);
    await sandbox.deleteTx('tx-1', 'Coffee $& $$');
    expect(asked[0]).toContain('"Coffee $& $$"');
  });

  it('re-reads the locale when the user settings change', async () => {
    const { sandbox } = loadFragment('cards');
    sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ locale: 'es' }) });
    sandbox.onAppDataChanged(['userSettings']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sandbox.currentLocale).toBe('es');
  });
});
