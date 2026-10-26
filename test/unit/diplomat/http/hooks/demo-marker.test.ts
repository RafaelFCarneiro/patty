import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  DEMO_TITLE_PREFIX,
  INSTANCE_KIND_ATTRIBUTE,
  markDemoPage,
  registerDemoMarkerHook,
} from '../../../../../src/diplomat/http/hooks/demo-marker.js';
import { InstanceKind } from '../../../../../src/models/instance.js';

const PAGE =
  '<!doctype html><html><head><title>FinTrack — log in</title></head><body class="x"><main>hi</main></body></html>';

describe('markDemoPage', () => {
  it('starts the title with [Demo]', () => {
    expect(markDemoPage(PAGE)).toContain(`<title>${DEMO_TITLE_PREFIX}FinTrack — log in</title>`);
  });

  it('puts the banner first in <body>, keeping the existing attributes', () => {
    const marked = markDemoPage(PAGE);
    expect(marked).toContain(`<body class="x" ${INSTANCE_KIND_ATTRIBUTE}="demo"><div class="demo-banner"`);
    expect(marked).toContain('sample data, not your finances.');
    expect(marked).toContain('Install FinTrack for your own data');
    expect(marked.indexOf('demo-banner')).toBeLessThan(marked.indexOf('<main>'));
  });

  it('leaves a fragment (no <body>) untouched', () => {
    const fragment = '<section><title>x</title></section>';
    expect(markDemoPage(fragment)).toBe(fragment);
  });
});

describe('registerDemoMarkerHook', () => {
  const appFor = (kind: InstanceKind) => {
    const app = Fastify();
    registerDemoMarkerHook(app, async () => kind);
    app.get('/page', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
    app.get('/data', async () => ({ title: '<title>x</title><body>' }));
    return app;
  };

  it('marks an HTML page of a demo database', async () => {
    const res = await appFor(InstanceKind.enum.demo).inject({ method: 'GET', url: '/page' });
    expect(res.body).toContain('demo-banner');
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
