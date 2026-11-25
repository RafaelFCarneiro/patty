import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFragment } from './fragment-sandbox.js';

const rootPath = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

const filesUnder = (relative: string): string[] =>
  readdirSync(rootPath(relative), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(`${relative}/${entry.name}`) : [`${relative}/${entry.name}`],
  );

const PERSONAL_NAME = /rafael|carneiro/i;
const SHIPPED_ROOTS = ['ui/dashboards', 'ui/guides', 'src/diplomat/db/seed'];
const CARD_LABEL = 'card_label';
const HOLDER_NAME_ELEMENT = /<div class="card-holder-name">([^<]*)<\/div>/g;

describe('no personal name ships in the product', () => {
  it.each(SHIPPED_ROOTS.flatMap(filesUnder))('%s contains no personal name', (file) => {
    expect(readFileSync(rootPath(file), 'utf-8')).not.toMatch(PERSONAL_NAME);
  });
});

describe('cards.html mock-ups show the card own name', () => {
  const source = readFileSync(rootPath('ui/dashboards/cards.html'), 'utf-8');
  const holderTemplates = [...source.matchAll(HOLDER_NAME_ELEMENT)].map((match) => match[1]);

  it('reads the holder line of all three mock-ups from the card, upper-cased', () => {
    expect(holderTemplates).toEqual([
      '${escapeHtml(String(c.name).toUpperCase())}',
      '${escapeHtml(String(name).toUpperCase())}',
      '${escapeHtml(String(name).toUpperCase())}',
    ]);
  });

  it('labels the holder line from the i18n table in every locale', () => {
    expect(source.match(new RegExp(`${CARD_LABEL}: "`, 'g'))).toHaveLength(3);
    expect(source.match(new RegExp(`\\$\\{t\\('${CARD_LABEL}'\\)\\}`, 'g'))).toHaveLength(3);
  });

  it('renders the upper-cased name in the carousel and both previews', () => {
    const { sandbox, document } = loadFragment('cards');
    sandbox.accounts = [];
    sandbox.creditCards = [
      { id: 'card-1', name: 'Nubank Roxo', currency: 'BRL', limit: 1000, closingDay: 5, dueDay: 15 },
    ];
    sandbox.renderCardsCarousel();
    expect(document.getElementById('cards-container').innerHTML).toContain('NUBANK ROXO');

    document.getElementById('card-add-name').value = 'Mi Tarjeta';
    sandbox.updateCardPreview();
    expect(document.getElementById('card-preview-element').innerHTML).toContain('>MI TARJETA<');

    document.getElementById('card-edit-name').value = 'Visa Gold';
    sandbox.updateCardEditPreview();
    expect(document.getElementById('card-edit-preview-element').innerHTML).toContain('>VISA GOLD<');
  });
});
