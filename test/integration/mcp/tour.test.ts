import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { DemoCountry } from '../../../src/models/demo.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { NPX_COMMAND } from '../../../src/models/package.js';
import { PromptName } from '../../../src/models/prompts.js';
import { TOUR_FACTS } from '../../../src/models/tour.js';
import { buildApp, type AppContext } from '../app-builder.js';

const dirs: string[] = [];
const apps: AppContext[] = [];

type Marking = { kind: InstanceKind; locale?: Locale; baseCurrency?: CurrencyCode };

const appOf = async ({ kind, locale, baseCurrency }: Marking): Promise<AppContext> => {
  const dir = mkdtempSync(join(tmpdir(), 'fintrack-tour-'));
  dirs.push(dir);
  const ctx = await buildApp({ dbPath: join(dir, 'test.db') });
  apps.push(ctx);
  await ctx.app.ready();
  await ctx.db.run(sql`UPDATE settings SET instance_kind = ${kind} WHERE id = 'singleton'`);
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
    [DemoCountry.enum.br, Locale.enum.pt, CurrencyCode.enum.BRL, 'Passo 1'],
    [DemoCountry.enum.us, Locale.enum.en, CurrencyCode.enum.USD, 'Step 1'],
    [DemoCountry.enum.mx, Locale.enum.es, CurrencyCode.enum.MXN, 'Paso 1'],
    [DemoCountry.enum.co, Locale.enum.es, CurrencyCode.enum.COP, 'Paso 1'],
  ])('on a %s demo reads the country and language from the database', async (country, locale, baseCurrency, step) => {
    const text = await tourOver(await appOf({ kind: InstanceKind.enum.demo, locale, baseCurrency }));
    expect(text).toContain(step);
    expect(text).toContain(TOUR_FACTS[country].destination);
    expect(text).toContain(TOUR_FACTS[country].statement[0]?.description);
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
