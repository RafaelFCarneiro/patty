import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Scoped } from '../../../../src/controllers/deps.js';
import type { McpContext } from '../../../../src/diplomat/mcp/context.js';
import { documentationContext } from '../../../../src/diplomat/http/context.js';
import { buildOpenApiDocument } from '../../../../src/diplomat/http/openapi.js';
import { buildRouteDefinitions } from '../../../../src/diplomat/http/routes.js';
import { promptDefinitions } from '../../../../src/diplomat/mcp/prompts.js';
import { ToolName } from '../../../../src/diplomat/mcp/tool-name.js';
import { toolDefinitions } from '../../../../src/diplomat/mcp/tools/index.js';
import { PromptName } from '../../../../src/models/prompts.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const openApiDocument = buildOpenApiDocument(buildRouteDefinitions(documentationContext('0.0.0-test')), '0.0.0-test');
const ctx = { version: '0.0.0-test', openApiDocument, as: () => scoped } as McpContext;
const scoped = { deps: { clock: () => new Date('2026-03-15T12:00:00Z') } } as unknown as Scoped;

const call = (name: ToolName, args: Record<string, unknown> = {}) => {
  const definition = toolDefinitions.find((candidate) => candidate.name === name)!;
  return definition.handle(args, scoped, ctx);
};
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]!.text!;

describe('get_api_contract', () => {
  it('without input answers the index: an intro line, then one line per route', async () => {
    const result = await call(ToolName.enum.get_api_contract);
    const lines = textOf(result).split('\n');
    expect(lines[0]).toContain('get_api_contract');
    expect(lines).toHaveLength(1 + buildRouteDefinitions(documentationContext('0.0.0-test')).length);
    expect(lines.some((line) => line.startsWith('GET /api/portfolio — '))).toBe(true);
  });

  it('with a path answers that route’s schema, as JSON', async () => {
    const result = await call(ToolName.enum.get_api_contract, { path: '/api/assets', method: 'get' });
    const [detail] = JSON.parse(textOf(result));
    expect(detail.path).toBe('/api/assets');
    expect(detail.parameters.map((p: { name: string }) => p.name)).toEqual(['assetClass', 'staleOnly']);
  });

  it('answers an unknown path as a validation error naming close matches', async () => {
    const result = await call(ToolName.enum.get_api_contract, { path: '/api/portfolios' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('close matches');
  });
});

describe('get_dashboard_guide', () => {
  it('returns the guide shipped with the package, whole', async () => {
    const guide = readFileSync(join(ROOT, 'ui', 'guides', 'dashboard-building.md'), 'utf8');
    expect(textOf(await call(ToolName.enum.get_dashboard_guide))).toBe(guide);
  });

  it('reads the contract through get_api_contract, and names the alternatives', () => {
    const guide = readFileSync(join(ROOT, 'ui', 'guides', 'dashboard-building.md'), 'utf8');
    expect(guide).toContain('get_api_contract');
    expect(guide).toContain('patty://openapi');
    expect(guide).toContain('GET /api/openapi.json');
  });

  it('is shipped: the package and the image carry ui/ and skills/ (without the skill evals)', () => {
    const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files as string[];
    expect(files).toEqual(expect.arrayContaining(['ui', 'skills', '!skills/**/evals']));
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY ui ./ui');
    expect(dockerfile).toContain('COPY skills ./skills');
  });
});

describe('get_workflow', () => {
  const withArguments: Partial<Record<PromptName, Record<string, unknown>>> = {
    monthly_review: { month: 3, year: 2026 },
    budget_checkup: { month: 11, year: 2025 },
    import_statement: { source: 'card' },
  };
  // `tour` reads the database: the integration test compares it.
  const pure = PromptName.options.filter((name) => name !== PromptName.enum.tour);

  it.each(pure)('returns the messages the %s prompt returns', async (name) => {
    const args = withArguments[name] ?? {};
    const prompt = promptDefinitions.find((definition) => definition.name === name)!;
    const expected = await prompt.handle(args, scoped, ctx);

    expect(JSON.parse(textOf(await call(ToolName.enum.get_workflow, { name, ...args })))).toEqual(expected);
  });

  it('uses the arguments it is given: another period, another text', async () => {
    const march = textOf(await call(ToolName.enum.get_workflow, { name: 'monthly_review', month: 3, year: 2026 }));
    const default_ = textOf(await call(ToolName.enum.get_workflow, { name: 'monthly_review' }));
    expect(march).toContain('03/2026');
    expect(default_).toContain('03/2026');
    expect(textOf(await call(ToolName.enum.get_workflow, { name: 'monthly_review', month: 11, year: 2025 }))).toContain(
      '11/2025',
    );
  });

  it('without a name lists every workflow with its description and its argument names', async () => {
    const list = JSON.parse(textOf(await call(ToolName.enum.get_workflow)));
    expect(list.map((item: { name: string }) => item.name)).toEqual(promptDefinitions.map(({ name }) => name));
    expect(list.find((item: { name: string }) => item.name === 'monthly_review').arguments).toEqual(['month', 'year']);
    list.forEach((item: { description: string }) => expect(item.description.length).toBeGreaterThan(0));
  });
});
