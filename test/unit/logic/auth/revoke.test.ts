import { PersistOp, type Persistable } from '@rfc0/effect-runner';
import { describe, expect, it } from 'vitest';
import { endedCredentials, endingCredentials, removeSession } from '../../../../src/logic/auth/revoke.js';
import { ACCESS_TOKEN_ENTITY_TAG, SESSION_ENTITY_TAG } from '../../../../src/models/auth/entity.js';
import type { SessionEntity } from '../../../../src/models/auth/session.js';
import { type AccessTokenEntity, AccessTokenKind } from '../../../../src/models/auth/token.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const LATER = '2026-10-20T00:00:00.000Z';

const session = (id: string): SessionEntity => ({
  id,
  userId: 'ana',
  tokenHash: `sha(${id})`,
  createdAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(),
  expiresAt: LATER,
  version: 3,
});

const token = (id: string, overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id,
  userId: 'ana',
  kind: AccessTokenKind.enum.pat,
  clientName: null,
  profile: null,
  name: id,
  tokenHash: `sha(${id})`,
  prefix: 'ftk_abcdef',
  scopes: ['fintrack:read'],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: LATER,
  revokedAt: null,
  version: 2,
  ...overrides,
});

const modelOf = (persistable: Persistable): AccessTokenEntity =>
  (persistable as unknown as { model: AccessTokenEntity }).model;

describe('removeSession', () => {
  it('deletes the session at the version that was read', () => {
    expect(removeSession(session('s1'))).toEqual({
      op: PersistOp.enum.delete,
      entity: SESSION_ENTITY_TAG,
      id: 's1',
      version: 3,
    });
  });
});

describe('endingCredentials', () => {
  it('deletes every session and revokes every live token — personal and stdio alike — and reports the counts', () => {
    const stdio = token('stdio', { kind: AccessTokenKind.enum.stdio, clientName: 'Claude', profile: 'default' });
    const ended = endingCredentials({ sessions: [session('s1'), session('s2')], tokens: [token('pat'), stdio] }, NOW);

    expect(ended.revoked).toEqual({ sessionsEnded: 2, tokensRevoked: 2 });
    expect(ended.persist.map((p) => `${p.op}:${p.entity}`)).toEqual([
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${ACCESS_TOKEN_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${ACCESS_TOKEN_ENTITY_TAG}`,
    ]);
    const revoked = ended.persist.filter((p) => p.op === PersistOp.enum.update);
    expect(revoked.map((p) => modelOf(p).revokedAt)).toEqual([NOW.toISOString(), NOW.toISOString()]);
    // The rows are kept, with the version that was read, so the list still shows what existed.
    expect(revoked.map((p) => modelOf(p).version)).toEqual([2, 2]);
  });

  it('leaves a token that is already revoked or expired alone', () => {
    const ended = endingCredentials(
      {
        sessions: [],
        tokens: [
          token('revoked', { revokedAt: '2026-10-01T00:00:00.000Z' }),
          token('lapsed', { expiresAt: '2026-10-01T00:00:00.000Z' }),
          token('legacy', { expiresAt: null }),
        ],
      },
      NOW,
    );
    // A legacy token with no expiry is live until revoked, so it is the one that is revoked.
    expect(ended.revoked).toEqual({ sessionsEnded: 0, tokensRevoked: 1 });
    expect(ended.persist).toHaveLength(1);
  });

  it('writes nothing for a user who holds nothing', () => {
    expect(endingCredentials({ sessions: [], tokens: [] }, NOW)).toEqual({
      persist: [],
      revoked: { sessionsEnded: 0, tokensRevoked: 0 },
    });
  });
});

describe('endedCredentials — the one rule', () => {
  it('returns every session, the live tokens already revoked, and the counts — as data, no writes', () => {
    const stdio = token('stdio', { kind: AccessTokenKind.enum.stdio });
    const ended = endedCredentials(
      { sessions: [session('s1')], tokens: [token('pat'), stdio, token('old', { revokedAt: 'x' })] },
      NOW,
    );
    expect(ended.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(ended.tokens.map((t) => [t.id, t.revokedAt])).toEqual([
      ['pat', NOW.toISOString()],
      ['stdio', NOW.toISOString()],
    ]);
    expect(ended.revoked).toEqual({ sessionsEnded: 1, tokensRevoked: 2 });
  });

  it('is what the writes are built from: same counts, one delete and one update per item', () => {
    const held = { sessions: [session('s1'), session('s2')], tokens: [token('pat')] };
    expect(endingCredentials(held, NOW).revoked).toEqual(endedCredentials(held, NOW).revoked);
    expect(endingCredentials(held, NOW).persist).toHaveLength(3);
  });
});
