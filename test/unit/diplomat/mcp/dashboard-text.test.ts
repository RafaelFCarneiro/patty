import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolName } from '../../../../src/diplomat/mcp/tool-name.js';
import { toolDefinitions } from '../../../../src/diplomat/mcp/tools/index.js';
import { FRAGMENT_SHAPE, SaveDashboardSchema } from '../../../../src/models/dashboard.js';

const toolDescription =
  toolDefinitions.find(({ name }) => name === ToolName.enum.save_dashboard)?.config.description ?? '';
const htmlDescription = SaveDashboardSchema.shape.html.description ?? '';
const guide = readFileSync(new URL('../../../../ui/guides/dashboard-building.md', import.meta.url), 'utf-8');

const FORBIDDEN_STYLE = /<head>`?\s*(?:\/|,|or)\s*`?<style>/;

describe('the fragment rules agent-facing text states', () => {
  it('word the shape once: the tool and the html field both include FRAGMENT_SHAPE', () => {
    expect(toolDescription).toContain(FRAGMENT_SHAPE);
    expect(htmlDescription).toContain(FRAGMENT_SHAPE);
  });

  it.each([
    ['the tool description', toolDescription],
    ['the html field description', htmlDescription],
    ['the guide', guide],
  ])('%s never lists <style> among what a fragment must not have', (_name, text) => {
    expect(text).not.toMatch(FORBIDDEN_STYLE);
  });

  it('keeps ADR references an agent cannot use out of the tool description', () => {
    expect(toolDescription).not.toMatch(/ADR-\d+/);
  });
});
