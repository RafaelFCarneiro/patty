import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../ui/${file}`, import.meta.url)), 'utf-8');

const SHELL_CLASSES = /<!-- shell-classes -->([\s\S]*?)<!-- \/shell-classes -->/;
const BACKTICKED_CLASS = /`([a-z][a-z-]*)`/g;
const CSS_CLASS = /\.([a-z][a-z-]*)/g;

// .panel predates the layer: ui/app.css holds its base and every bundled dashboard
// adds its own padding (docs/ui.md, #164). .dashboard-container is redefined by each
// bundled dashboard; app.css forces its width and margin.
const LOCALLY_EXTENDED = new Set(['panel', 'dashboard-container']);
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;
const declaresClass = (css: string, name: string) => new RegExp(`\\.${name}(?![\\w-])[^{}]*\\{`).test(css);

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const PAGE_HEADER_SNIPPET = /```html\n\s*(<div class="dashboard-container">\s*<header>[\s\S]*?)```/;
const HEADER_SHAPE =
  /<header>\s*<div class="header-title-area">\s*<h1><i class="fa-solid fa-[a-z-]+"><\/i>[\s\S]*?<\/h1>\s*<p[^>]*>[\s\S]*?<\/p>\s*<\/div>/;
const bundled = readdirSync(fileURLToPath(new URL('../../../ui/dashboards/', import.meta.url)));

const names = (text: string, pattern: RegExp) =>
  new Set([...text.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])));

describe('dashboard guide ↔ ui/app.css', () => {
  const guide = read('guides/dashboard-building.md');
  const cssClasses = names(read('app.css'), CSS_CLASS);
  const named = [...names(guide.match(SHELL_CLASSES)?.[1] ?? '', BACKTICKED_CLASS)];

  it('marks a non-empty class list', () => {
    expect(named.length).toBeGreaterThan(0);
  });

  it('names the component classes the shell provides', () => {
    expect(named).toEqual(
      expect.arrayContaining([
        'panel',
        'cards-grid',
        'card',
        'card-label',
        'card-value',
        'chart-box',
        'table-wrap',
        'data-table',
        'state',
        'state-error',
        'muted',
        'visually-hidden',
        'dashboard-header',
        'header-actions',
        'dashboard-container',
        'header-title-area',
      ]),
    );
  });

  it.each(named)('defines .%s in ui/app.css', (name) => {
    expect(cssClasses.has(name)).toBe(true);
  });

  it('never points at a class the shell lacks', () => {
    expect(guide).not.toContain('.dashboard-toolbar');
    expect(guide).not.toContain('placeholder-card');
  });

  it('is not shadowed by a bundled dashboard <style> declaring a shell class', () => {
    const shadowed = readdirSync(fileURLToPath(new URL('../../../ui/dashboards/', import.meta.url)))
      .map((file) => ({
        file,
        styles: [...read(`dashboards/${file}`).matchAll(STYLE_BLOCK)].map((match) => match[1] ?? '').join('\n'),
      }))
      .flatMap(({ file, styles }) =>
        named
          .filter((name) => !LOCALLY_EXTENDED.has(name) && declaresClass(styles, name))
          .map((name) => `${file}: .${name}`),
      );
    expect(shadowed).toEqual([]);
  });

  it('keeps the card grid from forcing a minimum wider than its container', () => {
    const grid = read('app.css').match(/\.cards-grid\s*\{[^}]*\}/)?.[0] ?? '';
    expect(grid).toMatch(/minmax\(min\([^,]+, 100%\), 1fr\)/);
  });

  it('shows a page header that uses only shell classes', () => {
    const snippet = guide.match(PAGE_HEADER_SNIPPET)?.[1] ?? '';
    expect(snippet).toMatch(HEADER_SHAPE);
    const used = [...snippet.matchAll(/class="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(/\s+/));
    const unknown = used.filter((name) => !name.startsWith('fa-') && !cssClasses.has(name));
    expect(unknown).toEqual([]);
  });

  it.each(bundled)('opens %s with the guide’s page header', (file) => {
    const body = read(`dashboards/${file}`).replace(STYLE_BLOCK, '').replace(HTML_COMMENT, '').trim();
    expect(body).toMatch(new RegExp(`^<div class="dashboard-container">\\s*${HEADER_SHAPE.source}`));
  });

  it('sends formatting through window.PATTY', () => {
    expect(guide).toContain('window.PATTY');
    expect(guide).toContain('maintainAspectRatio: false');
  });
});
