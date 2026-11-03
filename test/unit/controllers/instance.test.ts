import { describe, expect, it, vi } from 'vitest';
import { instanceFactsOf } from '../../../src/controllers/instance.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { Locale } from '../../../src/models/locale.js';

const tenancyOf = (kind: InstanceKind, locale: Locale = Locale.enum.pt) => ({
  instanceKind: async () => kind,
  instanceLocale: vi.fn(async () => locale),
});

describe('instanceFactsOf', () => {
  it('names a demo’s language', async () => {
    const tenancy = tenancyOf(InstanceKind.enum.demo, Locale.enum.es);
    expect(await instanceFactsOf(tenancy)).toEqual({ kind: InstanceKind.enum.demo, locale: Locale.enum.es });
  });

  it('does not read a language for a standard database', async () => {
    const tenancy = tenancyOf(InstanceKind.enum.standard);
    expect(await instanceFactsOf(tenancy)).toEqual({ kind: InstanceKind.enum.standard, locale: Locale.enum.en });
    expect(tenancy.instanceLocale).not.toHaveBeenCalled();
  });
});
