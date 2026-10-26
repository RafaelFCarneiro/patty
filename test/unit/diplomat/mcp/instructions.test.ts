import { describe, expect, it } from 'vitest';
import {
  DEMO_SERVER_INSTRUCTIONS,
  MCP_SERVER_NAME,
  serverInstructions,
} from '../../../../src/diplomat/mcp/instructions.js';
import { InstanceKind } from '../../../../src/models/instance.js';
import { Locale } from '../../../../src/models/locale.js';

const LOCALES = Object.values(Locale.enum);
const DEMO_WORD = { [Locale.enum.en]: 'DEMO', [Locale.enum.pt]: 'DEMO', [Locale.enum.es]: 'DEMO' } as const;
const SAMPLE_WORD = { [Locale.enum.en]: 'sample', [Locale.enum.pt]: 'exemplo', [Locale.enum.es]: 'ejemplo' } as const;

describe('serverInstructions', () => {
  it.each(LOCALES)('tells the client a %s demo is a demo, pointing at the real server for real finances', (locale) => {
    const text = serverInstructions({ kind: InstanceKind.enum.demo, locale });
    expect(text).toBe(DEMO_SERVER_INSTRUCTIONS[locale]);
    expect(text).toContain(DEMO_WORD[locale]);
    expect(text).toContain(SAMPLE_WORD[locale]);
    expect(text).toContain(`\`${MCP_SERVER_NAME}\``);
  });

  it('speaks a different language for each locale', () => {
    const texts = LOCALES.map((locale) => DEMO_SERVER_INSTRUCTIONS[locale]);
    expect(new Set(texts).size).toBe(LOCALES.length);
  });

  it.each(LOCALES)('sends nothing for a standard database, whatever the locale (%s)', (locale) => {
    expect(serverInstructions({ kind: InstanceKind.enum.standard, locale })).toBeUndefined();
  });
});
