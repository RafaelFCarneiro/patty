import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../ui/${file}`, import.meta.url)), 'utf-8');

const RULE_TEN = /^10\. \*\*A fragment, not a full page\.\*\*[\s\S]*?(?=^11\. )/m;
const BACKTICKED_CLASS = /`([a-z][a-z-]*)`/g;
const CSS_CLASS = /\.([a-z][a-z-]*)/g;

const names = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((match) => match[1]));

describe('dashboard guide ↔ ui/app.css', () => {
  const guide = read('guides/dashboard-building.md');
  const cssClasses = names(read('app.css'), CSS_CLASS);
  const named = [...names(guide.match(RULE_TEN)?.[0].split('use the shell')[1] ?? '', BACKTICKED_CLASS)];

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

  it('sends formatting through window.PATTY', () => {
    expect(guide).toContain('window.PATTY');
    expect(guide).toContain('maintainAspectRatio: false');
  });
});
