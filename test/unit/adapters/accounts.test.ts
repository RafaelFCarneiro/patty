import { describe, expect, it } from 'vitest';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { INITIAL_VERSION, PersistOp, type Persistable } from '@rfc0/effect-runner';
import * as wireInAccounts from '../../../src/wire/in/accounts.js';
import * as accountAdapters from '../../../src/adapters/accounts.js';
import type { AccountRow } from '../../../src/wire/db/accounts.js';

// Row as returned by a Drizzle select on the accounts table (schema-derived shape)
const sqlRow = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  initialBalance: 0,
  currency: CurrencyCode.enum.BRL,
  version: 0,
  ...overrides,
});

describe('dbToModel', () => {
  it('decodes flat SQL row with currency column', () => {
    const account = accountAdapters.dbToModel(sqlRow());
    expect(account).toEqual({
      id: 'acc-1',
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 0,
    });
  });

  it('decodes non-zero initialBalance', () => {
    const account = accountAdapters.dbToModel(sqlRow({ initialBalance: 1500 }));
    expect(account.initialBalance).toBe(1500);
  });

  it('rejects invalid records (decode at the boundary)', () => {
    expect(() => accountAdapters.dbToModel(sqlRow({ name: '' }))).toThrow();
  });
});

describe('wire CreateAccountSchema', () => {
  it('inherits .describe() from domain schema — no duplicated descriptions', () => {
    const domainType = wireInAccounts.CreateAccountSchema.shape.type.removeDefault().description;
    const domainCurrency = wireInAccounts.CreateAccountSchema.shape.currency.removeDefault().description;
    expect(domainType).toBeDefined();
    expect(domainCurrency).toBeDefined();
    expect(domainType).toContain('checking');
    expect(domainCurrency).toContain('ISO');
  });
});

describe('wire UpdateAccountSchema (HTTP PATCH pattern)', () => {
  it('rejects body without name (domain requires it)', () => {
    expect(wireInAccounts.UpdateAccountSchema.safeParse({ newName: 'B' }).success).toBe(false);
  });

  it('succeeds when name is merged from URL params before parsing', () => {
    const body = { newName: 'Renamed' };
    const merged = { ...body, name: 'Original' };
    const result = wireInAccounts.UpdateAccountSchema.safeParse(merged);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ name: 'Original', newName: 'Renamed' });
    }
  });
});

describe('createWireInToModel', () => {
  it('applies USD currency and 0 initialBalance defaults when omitted', () => {
    const parsed = wireInAccounts.CreateAccountSchema.parse({ name: 'Nubank', type: AccountType.enum.checking });
    expect(accountAdapters.createWireInToModel(parsed)).toEqual({
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.USD,
      initialBalance: 0,
    });
  });

  it('preserves explicit currency and initialBalance when provided', () => {
    const parsed = wireInAccounts.CreateAccountSchema.parse({
      name: 'USD Wallet',
      type: AccountType.enum.wallet,
      currency: CurrencyCode.enum.USD,
      initialBalance: 500,
    });
    expect(accountAdapters.createWireInToModel(parsed)).toEqual({
      name: 'USD Wallet',
      type: AccountType.enum.wallet,
      currency: CurrencyCode.enum.USD,
      initialBalance: 500,
    });
  });
});

describe('updateWireInToModel', () => {
  it('passes through a full update payload unchanged', () => {
    const parsed = wireInAccounts.UpdateAccountSchema.parse({
      name: 'Nubank',
      newName: 'Nubank Ultravioleta',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });
    expect(accountAdapters.updateWireInToModel(parsed)).toEqual(parsed);
  });

  it('passes through a minimal update (name only) unchanged', () => {
    const parsed = wireInAccounts.UpdateAccountSchema.parse({ name: 'Nubank' });
    expect(accountAdapters.updateWireInToModel(parsed)).toEqual({ name: 'Nubank' });
  });
});

const account: Account = {
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
};

const accountEntity: AccountEntity = { ...account, version: 3 };

describe('modelToDb', () => {
  it('carries every field, including version, onto the row', () => {
    expect(accountAdapters.modelToDb(accountEntity)).toEqual({ ...account, version: 3 });
  });
});

describe('persistableToDb (accounts) — model→row adaptation lives at the diplomat edge', () => {
  it('insert: bakes in INITIAL_VERSION — the model never carries one', () => {
    const p: Persistable = { op: PersistOp.enum.insert, entity: ACCOUNT_ENTITY_TAG, model: account };
    expect(accountAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.insert,
      entity: ACCOUNT_ENTITY_TAG,
      model: { ...account, version: INITIAL_VERSION },
    });
  });

  it('update: adapts the versioned model to a row, keeping the version the core read', () => {
    const p: Persistable = { op: PersistOp.enum.update, entity: ACCOUNT_ENTITY_TAG, model: accountEntity };
    expect(accountAdapters.persistableToDb(p)).toEqual({
      op: PersistOp.enum.update,
      entity: ACCOUNT_ENTITY_TAG,
      model: { ...account, version: 3 },
    });
  });

  it('delete: passes through unchanged — there is no model to adapt', () => {
    const p: Persistable = { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: 'acc-1', version: 3 };
    expect(accountAdapters.persistableToDb(p)).toEqual(p);
  });

  it('no-ops on a persistable tagged for a different entity — never casts a foreign model as Account', () => {
    // A composed flow's batch can carry other entities' persistables too (ADR-021 rule 5,
    // "composition is concatenation"). persistableToDb must leave those alone rather than run
    // them through Account's modelToDb.
    const foreign: Persistable = {
      op: PersistOp.enum.insert,
      entity: 'transaction',
      model: { totallyNotAnAccount: true },
    };
    expect(accountAdapters.persistableToDb(foreign)).toEqual(foreign);
  });
});

describe('outcomeToDb', () => {
  it('maps every persistable in the batch through persistableToDb, leaving response untouched', () => {
    const outcome = {
      persist: [{ op: PersistOp.enum.insert, entity: ACCOUNT_ENTITY_TAG, model: account } as Persistable],
      response: account,
    };
    expect(accountAdapters.outcomeToDb(outcome)).toEqual({
      persist: [
        { op: PersistOp.enum.insert, entity: ACCOUNT_ENTITY_TAG, model: { ...account, version: INITIAL_VERSION } },
      ],
      response: account,
    });
  });

  it('on a mixed-entity batch, adapts only the account persistables and passes the rest through', () => {
    const foreign: Persistable = { op: PersistOp.enum.insert, entity: 'transaction', model: { id: 'tx-1' } };
    const outcome = {
      persist: [foreign, { op: PersistOp.enum.insert, entity: ACCOUNT_ENTITY_TAG, model: account } as Persistable],
      response: account,
    };

    expect(accountAdapters.outcomeToDb(outcome)).toEqual({
      persist: [
        foreign,
        { op: PersistOp.enum.insert, entity: ACCOUNT_ENTITY_TAG, model: { ...account, version: INITIAL_VERSION } },
      ],
      response: account,
    });
  });
});
