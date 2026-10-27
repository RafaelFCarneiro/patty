import { describe, expect, it } from 'vitest';
import { tourPromptText } from '../../../../src/diplomat/mcp/tour.js';
import { ToolName } from '../../../../src/diplomat/mcp/tool-name.js';
import { demoTourContext, standardTourContext } from '../../../../src/logic/tour.js';
import { DemoCountry, DEMO_SERVER_NAME } from '../../../../src/models/demo.js';
import { Locale } from '../../../../src/models/locale.js';
import { NPX_COMMAND } from '../../../../src/models/package.js';
import { TOUR_FACTS } from '../../../../src/models/tour.js';

const TODAY = '2026-10-26';
const LOCALES = Object.values(Locale.enum);
const COUNTRIES = Object.values(DemoCountry.enum);
const LOCALE_OF = {
  [DemoCountry.enum.br]: Locale.enum.pt,
  [DemoCountry.enum.us]: Locale.enum.en,
  [DemoCountry.enum.mx]: Locale.enum.es,
  [DemoCountry.enum.co]: Locale.enum.es,
} as const;

describe('tourPromptText — a demo', () => {
  it.each(COUNTRIES)('has six numbered steps, the destination and the sample statement (%s)', (country) => {
    const text = tourPromptText(demoTourContext(LOCALE_OF[country], country, TODAY));
    expect(text.match(/^\S+ \d\. /gm)).toHaveLength(6);
    expect(text).toContain(TOUR_FACTS[country].destination);
    TOUR_FACTS[country].statement.forEach(({ description }) => expect(text).toContain(description));
  });

  it.each(LOCALES)('names the tools each step calls and the way to remove the demo (%s)', (locale) => {
    const text = tourPromptText(demoTourContext(locale, DemoCountry.enum.us, TODAY));
    [
      ToolName.enum.get_account_balances,
      ToolName.enum.get_spending_summary,
      ToolName.enum.get_budget_status,
      ToolName.enum.import_account_statement,
      ToolName.enum.search_transactions,
      ToolName.enum.create_tag,
      ToolName.enum.save_dashboard,
    ].forEach((tool) => expect(text).toContain(tool));
    expect(text).toContain(`${NPX_COMMAND} setup <client> --remove-demo`);
  });

  it('is written in the demo’s language: each language’s text differs', () => {
    const texts = LOCALES.map((locale) => tourPromptText(demoTourContext(locale, DemoCountry.enum.us, TODAY)));
    expect(new Set(texts).size).toBe(LOCALES.length);
  });
});

describe('tourPromptText — a standard database', () => {
  it.each(LOCALES)('says the tour is for the demo and how to start it (%s)', (locale) => {
    const text = tourPromptText(standardTourContext(locale));
    expect(text).toContain(`${NPX_COMMAND} demo`);
    expect(text).toContain(`${NPX_COMMAND} setup <client> --demo`);
    expect(text).toContain(DEMO_SERVER_NAME);
    expect(text).not.toContain(ToolName.enum.get_account_balances);
  });
});
