import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  DEMO_BANNER_COPY,
  DEMO_TITLE_PREFIX,
  INSTANCE_KIND_ATTRIBUTE,
  markDemoPage,
  registerDemoMarkerHook,
} from '../../../../../src/diplomat/http/hooks/demo-marker.js';
import { InstanceKind } from '../../../../../src/models/instance.js';
import { Locale } from '../../../../../src/models/locale.js';

const LOCALES = Object.values(Locale.enum);

const PAGE =
  '<!doctype html><html><head><title>PATTY — log in</title></head><body class="x"><main>hi</main></body></html>';

describe('markDemoPage', () => {
  it.each(LOCALES)('starts the title with [Demo] (%s)', (locale) => {
    expect(markDemoPage(PAGE, locale)).toContain(`<title>${DEMO_TITLE_PREFIX}PATTY — log in</title>`);
  });

  it.each(LOCALES)('puts the %s banner first in <body>, keeping the existing attributes', (locale) => {
    const marked = markDemoPage(PAGE, locale);
    const { label, message, linkText } = DEMO_BANNER_COPY[locale];
    expect(marked).toContain(`<body class="x" ${INSTANCE_KIND_ATTRIBUTE}="demo"><div class="demo-banner"`);
    expect(marked).toContain(`<strong>${label}</strong> — ${message}`);
    expect(marked).toContain(linkText);
    expect(marked.indexOf('demo-banner')).toBeLessThan(marked.indexOf('<main>'));
  });

  it.each(LOCALES)('declares the banner’s own language (%s) inside an English page', (locale) => {
    expect(markDemoPage(PAGE, locale)).toContain(`<div class="demo-banner" role="note" lang="${locale}">`);
  });

  it('says the same thing in the three languages, in different words', () => {
    expect(markDemoPage(PAGE, Locale.enum.en)).toContain('sample data, not your finances.');
    expect(markDemoPage(PAGE, Locale.enum.pt)).toContain('dados de exemplo, não as suas finanças.');
    expect(markDemoPage(PAGE, Locale.enum.es)).toContain('datos de ejemplo, no tus finanzas.');
  });

  it('leaves a fragment (no <body>) untouched', () => {
    const fragment = '<section><title>x</title></section>';
    expect(markDemoPage(fragment, Locale.enum.en)).toBe(fragment);
  });
});

describe('registerDemoMarkerHook', () => {
  const appFor = (kind: InstanceKind, locale: Locale = Locale.enum.en) => {
    const app = Fastify();
    registerDemoMarkerHook(app, { instanceKind: async () => kind, instanceLocale: async () => locale });
    app.get('/page', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
    app.get('/data', async () => ({ title: '<title>x</title><body>' }));
    return app;
  };

  it('marks an HTML page of a demo database', async () => {
    const res = await appFor(InstanceKind.enum.demo).inject({ method: 'GET', url: '/page' });
    expect(res.body).toContain('demo-banner');
  });

  it.each(LOCALES)('marks a demo page in the demo’s language (%s)', async (locale) => {
    const res = await appFor(InstanceKind.enum.demo, locale).inject({ method: 'GET', url: '/page' });
    expect(res.body).toContain(DEMO_BANNER_COPY[locale].message);
  });

  it('never reads the language of a standard database', async () => {
    const app = Fastify();
    registerDemoMarkerHook(app, {
      instanceKind: async () => InstanceKind.enum.standard,
      instanceLocale: async () => {
        throw new Error('a standard database has no demo language');
      },
    });
    app.get('/page', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
    expect((await app.inject({ method: 'GET', url: '/page' })).body).toBe(PAGE);
  });

  it('never marks a standard database', async () => {
    const res = await appFor(InstanceKind.enum.standard).inject({ method: 'GET', url: '/page' });
    expect(res.body).toBe(PAGE);
  });

  it('leaves a JSON reply alone even on a demo database', async () => {
    const res = await appFor(InstanceKind.enum.demo).inject({ method: 'GET', url: '/data' });
    expect(res.json()).toEqual({ title: '<title>x</title><body>' });
  });
});
