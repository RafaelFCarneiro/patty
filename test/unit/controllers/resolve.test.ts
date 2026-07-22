import { describe, expect, it } from 'vitest';
import { resolveLegAccounts, resolveTagLinks } from '../../../src/controllers/resolve.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp } from '../../../src/models/persistable.js';
import { TRANSACTION_TAG_ENTITY_TAG } from '../../../src/models/transactionTag.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
  ...overrides,
});

const makeDeps = (accountsById: Record<string, Account>): Deps =>
  ({
    accounts: { findById: async (id: string) => accountsById[id] ?? null } as unknown as Deps['accounts'],
  }) as Deps;

describe('resolveLegAccounts (ADR-020 — neutral leg resolution, no ownership judgment)', () => {
  it('resolves the source account when only accountId is set', async () => {
    const deps = makeDeps({ 'acc-bank': account({ id: 'acc-bank' }) });
    const result = await resolveLegAccounts(deps, { accountId: 'acc-bank', toAccountId: undefined });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([account({ id: 'acc-bank' })]);
  });

  it('resolves both legs when accountId and toAccountId are both set (a transfer)', async () => {
    const deps = makeDeps({
      'acc-bank': account({ id: 'acc-bank', type: AccountType.enum.checking }),
      'acc-card': account({ id: 'acc-card', type: AccountType.enum.credit }),
    });
    const result = await resolveLegAccounts(deps, { accountId: 'acc-bank', toAccountId: 'acc-card' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((a) => a.id)).toEqual(['acc-bank', 'acc-card']);
  });

  it('returns an empty array when no leg is set (unattached movement)', async () => {
    const deps = makeDeps({});
    const result = await resolveLegAccounts(deps, { accountId: undefined, toAccountId: undefined });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('fails on the Result track (unknown_account) when a leg account no longer exists', async () => {
    const deps = makeDeps({});
    const result = await resolveLegAccounts(deps, { accountId: 'missing', toAccountId: undefined });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'unknown_account', query: 'missing' });
  });

  it('dedupes a leg id shared by accountId and toAccountId, fetching and returning it once', async () => {
    let callCount = 0;
    const deps = {
      accounts: {
        findById: async (id: string) => {
          callCount++;
          return account({ id });
        },
      },
    } as unknown as Deps;

    const result = await resolveLegAccounts(deps, { accountId: 'acc-1', toAccountId: 'acc-1' });

    expect(callCount).toBe(1);
    expect(result._unsafeUnwrap()).toEqual([account({ id: 'acc-1' })]);
  });
});

describe('resolveTagLinks — the transaction tag-set Persistable + matched names (ADR-023 steps 2–3)', () => {
  const tagsDeps = (tags: Array<{ id: string; name: string }>): Deps =>
    ({ tags: { list: async () => tags } }) as unknown as Deps;

  it('resolves given names into a tag-set insert addressed by the transaction id', async () => {
    const deps = tagsDeps([{ id: 'tag-work', name: 'work' }]);

    const resolved = await resolveTagLinks(deps, 'tx-1', ['work']);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    const { persistable, tags } = resolved;

    expect(persistable).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      model: { transactionId: 'tx-1', tagIds: ['tag-work'] },
    });
    expect(tags).toEqual(['work']);
  });

  it('drops an unmatched name from both the persisted ids and the returned names', async () => {
    const deps = tagsDeps([{ id: 'tag-work', name: 'work' }]);

    const resolved = await resolveTagLinks(deps, 'tx-1', ['work', 'does-not-exist']);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    const { persistable, tags } = resolved;

    expect(persistable).toMatchObject({ model: { tagIds: ['tag-work'] } });
    expect(tags).toEqual(['work']);
  });

  it('an explicit empty name list clears tags without reading the tag catalog', async () => {
    const deps = {
      tags: {
        list: () => {
          throw new Error('must not read the tag catalog when tagNames is already empty');
        },
      },
    } as unknown as Deps;

    const resolved = await resolveTagLinks(deps, 'tx-1', []);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    const { persistable, tags } = resolved;

    expect(persistable).toEqual({
      op: PersistOp.enum.insert,
      entity: TRANSACTION_TAG_ENTITY_TAG,
      model: { transactionId: 'tx-1', tagIds: [] },
    });
    expect(tags).toEqual([]);
  });

  it('returns null and reads nothing when tagNames is omitted — leave tags alone', async () => {
    const deps = {
      tags: {
        list: () => {
          throw new Error('must not read the tag catalog when tagNames is omitted');
        },
      },
    } as unknown as Deps;

    expect(await resolveTagLinks(deps, 'tx-1', undefined)).toBeNull();
  });
});
