import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../src/config.js';
import { DEFAULT_AUTH_MODE } from '../../../../src/models/auth/mode.js';
import { DEFAULT_PROFILE } from '../../../../src/models/auth/sign-in.js';
import { AggregateGroupBy, AggregateMetric, AggregateSort } from '../../../../src/models/aggregate.js';
import { UpdateAccountSchema } from '../../../../src/models/account.js';
import { AggregateSpendingInputSchema } from '../../../../src/wire/in/aggregate.js';
import { ClaimOptionsSchema } from '../../../../src/wire/in/cli.js';

// zod 4 applies `.default()` to the output and returns it without running the inner schema (zod 3 parsed it); where a
// default sits next to a transform, a preprocess or a `.partial()`, these tests pin the choice made (ADR-037 §4):
// `.default()` everywhere, because every default is already in its output form, and an update never defaults.
const DEFAULT_LIMIT = 50;
const PERIOD = { groupBy: AggregateGroupBy.enum.category, month: 3, year: 2026 };
const KEY = 'a'.repeat(64);

describe('defaults next to a preprocess (wire/in/aggregate)', () => {
  it('fills metric, sort and limit when the query omits them', () => {
    expect(AggregateSpendingInputSchema.parse({ ...PERIOD })).toMatchObject({
      metric: AggregateMetric.enum.sum,
      sort: AggregateSort.enum.desc,
      limit: DEFAULT_LIMIT,
    });
  });

  it('coerces a query-string limit and keeps it instead of the default', () => {
    expect(AggregateSpendingInputSchema.parse({ ...PERIOD, limit: '10' }).limit).toBe(10);
  });
});

describe('defaults next to a transform (config, CLI flags)', () => {
  const env = (extra: Record<string, string>) => loadConfig({ PATTY_DB_KEY: KEY, ...extra });

  it('PATTY_PROFILE: unset and empty both give the default profile, a padded name is trimmed', () => {
    expect(env({}).PATTY_PROFILE).toBe(DEFAULT_PROFILE);
    expect(env({ PATTY_PROFILE: '' }).PATTY_PROFILE).toBe(DEFAULT_PROFILE);
    expect(env({ PATTY_PROFILE: '  work ' }).PATTY_PROFILE).toBe('work');
  });

  it('PATTY_AUTH: unset and empty give the default mode', () => {
    expect(env({}).PATTY_AUTH).toBe(DEFAULT_AUTH_MODE);
    expect(env({ PATTY_AUTH: '' }).PATTY_AUTH).toBe(DEFAULT_AUTH_MODE);
  });

  it('rate staleness hours: unset gives the defaults, a value is coerced', () => {
    expect(env({}).FIAT_RATE_STALE_HOURS).toBe(24);
    expect(env({}).CRYPTO_RATE_STALE_HOURS).toBe(1);
    expect(env({ FIAT_RATE_STALE_HOURS: '6' }).FIAT_RATE_STALE_HOURS).toBe(6);
  });

  it('PORT: unset gives the default, a value is coerced', () => {
    expect(env({}).PORT).toBe(env({ PORT: String(env({}).PORT) }).PORT);
    expect(env({ PORT: '4000' }).PORT).toBe(4000);
  });

  it('--password-stdin defaults to false before the options are reshaped', () => {
    expect(ClaimOptionsSchema.parse({})).toEqual({ passwordStdin: false, username: undefined });
  });
});

describe('an update never defaults (models/account)', () => {
  it('leaves an omitted initialBalance absent, so the stored balance is not reset to 0', () => {
    expect(UpdateAccountSchema.parse({ name: 'Nubank' })).toEqual({ name: 'Nubank' });
  });

  it('keeps a balance that is sent, including 0', () => {
    expect(UpdateAccountSchema.parse({ name: 'Nubank', initialBalance: 0 })).toEqual({
      name: 'Nubank',
      initialBalance: 0,
    });
  });
});
