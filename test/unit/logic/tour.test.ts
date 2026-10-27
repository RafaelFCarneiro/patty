import { describe, expect, it } from 'vitest';
import { DEMO_PACKS } from '../../../src/diplomat/db/seed/demo/index.js';
import { demoTourContext, standardTourContext, tourCountryOf } from '../../../src/logic/tour.js';
import { DemoCountry } from '../../../src/models/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';
import { TOUR_FACTS } from '../../../src/models/tour.js';

const TODAY = '2026-10-26';
const COUNTRIES = Object.values(DemoCountry.enum);

describe('tourCountryOf', () => {
  it.each(COUNTRIES)('uses the country the seeder recorded, whatever the language (%s)', (country) => {
    expect(tourCountryOf(country, Locale.enum.en)).toBe(country);
  });

  it('falls back to the language’s default country for a demo with none recorded', () => {
    expect(tourCountryOf(null, Locale.enum.pt)).toBe(DemoCountry.enum.br);
    expect(tourCountryOf(null, Locale.enum.es)).toBe(DemoCountry.enum.mx);
    expect(tourCountryOf(null, Locale.enum.en)).toBe(DemoCountry.enum.us);
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
