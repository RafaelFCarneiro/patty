import { describe, expect, it } from 'vitest';
import {
  budgetCheckupPromptText,
  ImportStatementPromptArgsSchema,
  importStatementPromptText,
  monthlyReviewPromptText,
  PeriodPromptArgsSchema,
  resolvePromptPeriod,
} from '../../../../src/diplomat/mcp/prompts.js';
import { ImportStatementSource } from '../../../../src/models/prompts.js';

describe('resolvePromptPeriod', () => {
  it('uses the given month and year when both are provided', () => {
    expect(resolvePromptPeriod({ month: 3, year: 2026 }, new Date(2026, 6, 1))).toEqual({ month: 3, year: 2026 });
  });

  it('defaults both to the current period when neither is provided', () => {
    expect(resolvePromptPeriod({}, new Date(2026, 6, 15))).toEqual({ month: 7, year: 2026 });
  });

  it('defaults only the missing field when one is provided', () => {
    expect(resolvePromptPeriod({ year: 2024 }, new Date(2026, 6, 15))).toEqual({ month: 7, year: 2024 });
    expect(resolvePromptPeriod({ month: 1 }, new Date(2026, 6, 15))).toEqual({ month: 1, year: 2026 });
  });
});

describe('PeriodPromptArgsSchema', () => {
  const parse = (args: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(PeriodPromptArgsSchema).map(([key, schema]) => [key, schema.parse(args[key])]),
    );

  it('coerces string month/year (protocol arguments are always strings)', () => {
    expect(parse({ month: '3', year: '2026' })).toEqual({ month: 3, year: 2026 });
  });

  it('is optional — omitted arguments parse to undefined', () => {
    expect(parse({})).toEqual({ month: undefined, year: undefined });
  });

  it('rejects an out-of-range month', () => {
    expect(() => PeriodPromptArgsSchema.month.parse('13')).toThrow();
  });
});

describe('monthlyReviewPromptText', () => {
  it('interpolates a zero-padded month/year', () => {
    const text = monthlyReviewPromptText({ month: 3, year: 2026 });
    expect(text).toContain('03/2026');
  });

  it('mentions every tool the workflow orchestrates', () => {
    const text = monthlyReviewPromptText({ month: 1, year: 2026 });
    expect(text).toContain('get_spending_summary');
    expect(text).toContain('find_correlations');
    expect(text).toContain('spending_shifts');
    expect(text).toContain('budget_fit');
    expect(text).toContain('recurring_candidates');
    expect(text).toContain('get_budget_status');
    expect(text).toContain('create_recurring');
  });

  it('instructs never to sum across currencies', () => {
    expect(monthlyReviewPromptText({ month: 1, year: 2026 })).toMatch(/never sum across currencies/);
  });
});

describe('budgetCheckupPromptText', () => {
  it('interpolates a zero-padded month/year', () => {
    expect(budgetCheckupPromptText({ month: 11, year: 2025 })).toContain('11/2025');
  });

  it('mentions the tools and the write-back offer', () => {
    const text = budgetCheckupPromptText({ month: 1, year: 2026 });
    expect(text).toContain('get_budget_status');
    expect(text).toContain('budget_fit');
    expect(text).toContain('update_budget');
    expect(text).toContain('create_budget');
    expect(text).toMatch(/never sum across currencies/);
  });
});

describe('ImportStatementPromptArgsSchema', () => {
  it('accepts card or account', () => {
    expect(ImportStatementPromptArgsSchema.source.parse('card')).toBe('card');
    expect(ImportStatementPromptArgsSchema.source.parse('account')).toBe('account');
  });

  it('is optional', () => {
    expect(ImportStatementPromptArgsSchema.source.parse(undefined)).toBeUndefined();
  });

  it('rejects an unknown source', () => {
    expect(() => ImportStatementPromptArgsSchema.source.parse('crypto')).toThrow();
  });
});

describe('importStatementPromptText', () => {
  it('names import_card_statement when source is card', () => {
    const text = importStatementPromptText(ImportStatementSource.enum.card);
    expect(text).toContain('import_card_statement');
    expect(text).not.toContain('Ask the user whether this is');
  });

  it('names import_account_statement when source is account', () => {
    const text = importStatementPromptText(ImportStatementSource.enum.account);
    expect(text).toContain('import_account_statement');
    expect(text).not.toContain('Ask the user whether this is');
  });

  it('asks card-vs-account when source is omitted', () => {
    const text = importStatementPromptText(undefined);
    expect(text).toContain('import_card_statement');
    expect(text).toContain('import_account_statement');
    expect(text).toContain('Ask the user whether this is');
  });

  it('always asks for the pasted statement text and mentions needs_review confirmation', () => {
    const text = importStatementPromptText(undefined);
    expect(text).toMatch(/paste the statement text/);
    expect(text).toContain('needs_review');
  });
});
