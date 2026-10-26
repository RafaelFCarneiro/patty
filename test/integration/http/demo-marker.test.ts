import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceKind } from '../../../src/models/instance.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { claimOwner } from '../auth/helpers.js';

const dirs: string[] = [];
const apps: AppContext[] = [];

const appOf = async (kind: InstanceKind, auth?: Parameters<typeof buildApp>[0] extends infer O ? O : never) => {
  const dir = mkdtempSync(join(tmpdir(), 'fintrack-demo-marker-'));
  dirs.push(dir);
  const ctx = await buildApp({ dbPath: join(dir, 'test.db'), ...auth });
  apps.push(ctx);
  await ctx.app.ready();
  await ctx.db.run(sql`UPDATE settings SET instance_kind = ${kind} WHERE id = 'singleton'`);
  return ctx;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((ctx) => ctx.app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const BANNER = 'class="demo-banner"';
const DEMO_TITLE = '<title>[Demo] ';

describe('demo marker — shell (auth disabled)', () => {
  it('is on /ui and /ui/:name of a demo database, with [Demo] in the title', async () => {
    const ctx = await appOf(InstanceKind.enum.demo);
    for (const url of ['/ui', '/ui/overview']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.body, url).toContain(BANNER);
      expect(res.body, url).toContain(DEMO_TITLE);
      expect(res.body, url).toContain('data-instance-kind="demo"');
    }
  });

  it('is never on a standard database', async () => {
    const ctx = await appOf(InstanceKind.enum.standard);
    const res = await ctx.app.inject({ method: 'GET', url: '/ui' });
    expect(res.body).not.toContain('demo-banner');
    expect(res.body).not.toContain('[Demo]');
    expect(res.body).not.toContain('data-instance-kind');
  });

  it('follows the database: marking it later shows the banner without a restart', async () => {
    const ctx = await appOf(InstanceKind.enum.standard);
    expect((await ctx.app.inject({ method: 'GET', url: '/ui' })).body).not.toContain(BANNER);
    await ctx.db.run(sql`UPDATE settings SET instance_kind = 'demo' WHERE id = 'singleton'`);
    expect((await ctx.app.inject({ method: 'GET', url: '/ui' })).body).toContain(BANNER);
  });

  it('serves a demo database’s JSON and stylesheet unchanged', async () => {
    const ctx = await appOf(InstanceKind.enum.demo);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ status: 'ok', db: 'ok' });
    const css = await ctx.app.inject({ method: 'GET', url: '/ui/assets/app.css' });
    expect(css.body).toContain('.demo-banner');
    expect(css.body).not.toContain('<div');
  });
});

describe('demo marker — every page with auth required', () => {
  it('is on the sign-in pages and every signed-in page of a demo database', async () => {
    const ctx = await appOf(InstanceKind.enum.demo, { auth: {} });
    const setup = await ctx.app.inject({ method: 'GET', url: '/ui/setup' });
    expect(setup.body).toContain(BANNER);
    expect(setup.body).toContain(DEMO_TITLE);

    const cookie = await claimOwner(ctx);
    const headers = { cookie };
    const login = await ctx.app.inject({ method: 'GET', url: '/ui/login' });
    expect(login.body).toContain(BANNER);
    for (const url of ['/ui', '/ui/access/tokens', '/ui/access/users']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(BANNER);
      expect(res.body, url).toContain(DEMO_TITLE);
    }
  });

  it('is on none of them for a standard database', async () => {
    const ctx = await appOf(InstanceKind.enum.standard, { auth: {} });
    const cookie = await claimOwner(ctx);
    for (const url of ['/ui/login', '/ui', '/ui/access/tokens', '/ui/access/users']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.body, url).not.toContain('demo-banner');
    }
  });
});
