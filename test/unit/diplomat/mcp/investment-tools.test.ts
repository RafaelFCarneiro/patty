import { describe, expect, it } from 'vitest';
import { investmentTools } from '../../../../src/diplomat/mcp/tools/investment.js';
import { ToolName } from '../../../../src/diplomat/mcp/tool-name.js';
import { DEFAULT_MANUAL_PRICE_STALE_DAYS, DEFAULT_PRICE_STALE_HOURS } from '../../../../src/models/asset.js';

describe('investment tool descriptions', () => {
  it('state the staleness defaults from the configuration constants, never a copy of the numbers', () => {
    const description = investmentTools.find((tool) => tool.name === ToolName.enum.list_assets)!.config.description;
    expect(description).toContain(`default ${DEFAULT_PRICE_STALE_HOURS} h`);
    expect(description).toContain(`default ${DEFAULT_MANUAL_PRICE_STALE_DAYS})`);
  });

  it('tell the agent a deleted opening gives its cash back', () => {
    const description = investmentTools.find((tool) => tool.name === ToolName.enum.delete_investment_event)!.config
      .description;
    expect(description).toContain('gives back');
  });
});
