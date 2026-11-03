import { describe, expect, it } from 'vitest';
import { DEMO_PACKS } from '../../../src/diplomat/db/seed/demo/index.js';
import { demoTourContext, standardTourContext, tourCountryOf } from '../../../src/logic/tour.js';
import { DemoCountry } from '../../../src/models/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { TOUR_FACTS } from '../../../src/models/tour.js';

const TODAY = '2026-10-26';
const COUNTRIES = Object.values(DemoCountry.enum);

describe('tourCountryOf', () => {
  it.each(COUNTRIES)('keeps the recorded country authoritative, whatever the currency or language (%s)', (country) => {
    expect(tourCountryOf(country, CurrencyCode.enum.BTC, Locale.enum.en)).toBe(country);
  });

  it.each(COUNTRIES)('resolves a legacy demo from its pack’s base currency (%s)', (country) => {
    const pack = DEMO_PACKS[country];
    expect(tourCountryOf(null, pack.currency, pack.locale)).toBe(country);
  });

  it('a legacy Spanish demo in COP is Colombia, not Mexico', () => {
    expect(tourCountryOf(null, CurrencyCode.enum.COP, Locale.enum.es)).toBe(DemoCountry.enum.co);
  });

  it('falls back to the language’s default when the base currency is no pack’s', () => {
    expect(tourCountryOf(null, CurrencyCode.enum.BTC, Locale.enum.pt)).toBe(DemoCountry.enum.br);
    expect(tourCountryOf(null, CurrencyCode.enum.USDC, Locale.enum.es)).toBe(DemoCountry.enum.mx);
  });
});

describe('demoTourContext', () => {
  it.each(COUNTRIES)('names the trip’s destination, the one the %s pack seeded', (country) => {
    const context = demoTourContext(DEMO_PACKS[country].locale, country, TODAY);
    expect(context).toMatchObject({ kind: InstanceKind.enum.demo, destination: DEMO_PACKS[country].trip.destination });
  });

  it.each(COUNTRIES)('dates the %s sample statement before today, with an income and an XPTO line', (country) => {
    const context = demoTourContext(DEMO_PACKS[country].locale, country, TODAY);
    if (context.kind !== InstanceKind.enum.demo) throw new Error('expected a demo context');
    expect(context.statement).toHaveLength(TOUR_FACTS[country].statement.length);
    expect(context.statement.every(({ date }) => date < TODAY && date >= '2026-10-20')).toBe(true);
    expect(context.statement.filter(({ income }) => income)).toHaveLength(1);
    expect(context.statement.some(({ description }) => description.includes('XPTO'))).toBe(true);
  });

  it('dates across a month boundary', () => {
    const context = demoTourContext(Locale.enum.en, DemoCountry.enum.us, '2026-11-02');
    if (context.kind !== InstanceKind.enum.demo) throw new Error('expected a demo context');
    expect(context.statement.map(({ date }) => date)).toEqual(['2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29']);
  });
});

describe('standardTourContext', () => {
  it('carries only the language', () => {
    expect(standardTourContext(Locale.enum.pt)).toEqual({ kind: InstanceKind.enum.standard, locale: Locale.enum.pt });
  });
});
