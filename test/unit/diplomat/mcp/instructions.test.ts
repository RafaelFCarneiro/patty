import { describe, expect, it } from 'vitest';
import { DEMO_SERVER_INSTRUCTIONS, serverInstructions } from '../../../../src/diplomat/mcp/instructions.js';
import { InstanceKind } from '../../../../src/models/instance.js';

describe('serverInstructions', () => {
  it('tells the client a demo database is a demo, pointing at the real server for real finances', () => {
    const text = serverInstructions(InstanceKind.enum.demo);
    expect(text).toBe(DEMO_SERVER_INSTRUCTIONS);
    expect(text).toContain('DEMO');
    expect(text).toContain('`fintrack`');
  });

  it('sends nothing for a standard database', () => {
    expect(serverInstructions(InstanceKind.enum.standard)).toBeUndefined();
  });
});
