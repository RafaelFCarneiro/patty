import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { DemoCountry } from '../../../src/models/demo/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { NPX_COMMAND } from '../../../src/models/package.js';
import { PromptName } from '../../../src/models/prompts.js';
import { TOUR_FACTS } from '../../../src/models/demo/tour.js';
import { seedDemo } from '../../../src/composition/demo/seed.js';
import { createRuntime } from '../../../src/composition/runtime.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DEMO_PACKS } from '../../../src/diplomat/db/seed/demo/index.js';
import { buildApp, type AppContext } from '../app-builder.js';

const dirs: string[] = [];
const apps: AppContext[] = [];

type Marking = { kind: InstanceKind; locale?: Locale; baseCurrency?: CurrencyCode; country?: DemoCountry };

const appOf = async ({ kind, locale, baseCurrency, country }: Marking): Promise<AppContext> => {
  const dir = mkdtempSync(join(tmpdir(), 'fintrack-tour-'));
  dirs.push(dir);
  const ctx = await buildApp({ dbPath: join(dir, 'test.db') });
  apps.push(ctx);
  await ctx.app.ready();
  await ctx.db.run(sql`UPDATE settings SET instance_kind = ${kind} WHERE id = 'singleton'`);
  if (country) await ctx.db.run(sql`UPDATE settings SET demo_country = ${country} WHERE id = 'singleton'`);
  if (locale) {
    await ctx.db.run(
      sql`INSERT INTO user_settings (user_id, locale, locale_source, base_currency)
          VALUES ('user-owner', ${locale}, 'explicit', ${baseCurrency ?? null})`,
    );
  }
  return ctx;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((ctx) => ctx.app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const tourOver = async (ctx: AppContext, args?: Record<string, string>): Promise<string> => {
  const server = buildMcpServer(ctx.runtime, ctx.version, { gate: ownerGate });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tour-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const listed = (await client.listPrompts()).prompts.map(({ name }) => name);
  expect(listed).toContain(PromptName.enum.tour);
  const result = await client.getPrompt({ name: PromptName.enum.tour, arguments: args });
  await client.close();
  await server.close();
  const content = result.messages[0]?.content;
  return content?.type === 'text' ? content.text : '';
};

describe('tour prompt', () => {
  it.each([
    [DemoCountry.enum.br, Locale.enum.pt, 'Passo 1'],
    [DemoCountry.enum.us, Locale.enum.en, 'Step 1'],
    [DemoCountry.enum.mx, Locale.enum.es, 'Paso 1'],
    [DemoCountry.enum.co, Locale.enum.es, 'Paso 1'],
  ])('on a %s demo reads the recorded country and the language from the database', async (country, locale, step) => {
    const text = await tourOver(await appOf({ kind: InstanceKind.enum.demo, locale, country }));
    expect(text).toContain(step);
    expect(text).toContain(TOUR_FACTS[country].destination);
    expect(text).toContain(TOUR_FACTS[country].statement[0]?.description);
  });

  it('a demo whose base currency was changed still gets its own destination', async () => {
    const ctx = await appOf({
      kind: InstanceKind.enum.demo,
      locale: Locale.enum.pt,
      baseCurrency: CurrencyCode.enum.USD,
      country: DemoCountry.enum.br,
    });
    expect(await tourOver(ctx)).toContain(TOUR_FACTS[DemoCountry.enum.br].destination);
  });

  it('a legacy Spanish demo in COP with no recorded country gets Cartagena, not Oaxaca', async () => {
    const ctx = await appOf({
      kind: InstanceKind.enum.demo,
      locale: Locale.enum.es,
      baseCurrency: CurrencyCode.enum.COP,
    });
    const text = await tourOver(ctx);
    expect(text).toContain(TOUR_FACTS[DemoCountry.enum.co].destination);
    expect(text).not.toContain(TOUR_FACTS[DemoCountry.enum.mx].destination);
  });

  it('a demo with no recorded country and no pack currency gets the language’s default', async () => {
    const text = await tourOver(
      await appOf({ kind: InstanceKind.enum.demo, locale: Locale.enum.es, baseCurrency: CurrencyCode.enum.BTC }),
    );
    expect(text).toContain(TOUR_FACTS[DemoCountry.enum.mx].destination);
  });

  it('a Spanish demo with neither country nor base currency recorded gets the language’s default', async () => {
    const text = await tourOver(await appOf({ kind: InstanceKind.enum.demo, locale: Locale.enum.es }));
    expect(text).toContain(TOUR_FACTS[DemoCountry.enum.mx].destination);
  });

  it('on a demo with no saved language falls back to English and the US data set', async () => {
    const text = await tourOver(await appOf({ kind: InstanceKind.enum.demo }));
    expect(text).toContain('Step 1');
    expect(text).toContain(TOUR_FACTS[DemoCountry.enum.us].destination);
  });

  it('needs no arguments object', async () => {
    const text = await tourOver(await appOf({ kind: InstanceKind.enum.demo }), undefined);
    expect(text.length).toBeGreaterThan(0);
  });

  it('on a standard database says the tour is for the demo and how to start it, and runs none of it', async () => {
    const text = await tourOver(await appOf({ kind: InstanceKind.enum.standard, locale: Locale.enum.pt }));
    expect(text).toContain(`${NPX_COMMAND} demo`);
    expect(text).not.toContain('get_account_balances');
    Object.values(TOUR_FACTS).forEach(({ destination }) => expect(text).not.toContain(destination));
  });
});

describe('tour prompt on a seeded demo', () => {
  const TODAY = new Date(2026, 9, 26, 9);
  const CONFIG = { FIAT_RATE_STALE_HOURS: 24, CRYPTO_RATE_STALE_HOURS: 1 };
  const STEP_LABEL = { pt: 'Passo 1', en: 'Step 1', es: 'Paso 1' } as const satisfies Record<Locale, string>;
  const seeded: Db[] = [];

  afterEach(() => seeded.splice(0).forEach(closeDatabase));

  it.each(Object.values(DemoCountry.enum))(
    '%s: the seeded database yields its destination and language',
    async (country) => {
      const dir = mkdtempSync(join(tmpdir(), 'fintrack-tour-seed-'));
      dirs.push(dir);
      const db = await openDatabase({ DB_PATH: join(dir, 'demo.db'), FINTRACK_DB_KEY: 'd'.repeat(64) });
      seeded.push(db);
      await bootstrap(db);
      await seedDemo(db, { country, today: TODAY, config: CONFIG });
      const runtime = createRuntime(db, { ...CONFIG, FINTRACK_LOCALE: undefined }, { clock: () => TODAY });

      const server = buildMcpServer(runtime, 'test', { gate: ownerGate });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'tour-seed-test', version: '1' });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.getPrompt({ name: PromptName.enum.tour });
      await client.close();
      await server.close();

      const content = result.messages[0]?.content;
      const text = content?.type === 'text' ? content.text : '';
      expect(text).toContain(TOUR_FACTS[country].destination);
      expect(text).toContain(STEP_LABEL[DEMO_PACKS[country].locale]);
    },
  );
});
