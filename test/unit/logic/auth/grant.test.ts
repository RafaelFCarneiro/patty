import { describe, expect, it } from 'vitest';
import {
  approvedGrant,
  consentChoice,
  deniedGrant,
  durationAllowedFor,
  expiredGrant,
  formatUserCode,
  grantRequestOf,
  isAnswerable,
  newGrant,
  newStdioSignIn,
  normalizeUserCode,
  persistsToKeychain,
  redeemPlan,
  redeemedGrant,
  sessionOnlyLabel,
  signInExpiry,
  supersededGrants,
} from '../../../../src/logic/auth/grant.js';
import {
  CLIENT_GRANT_TTL_MS,
  GrantChannel,
  GrantStatus,
  MAX_SIGN_IN_DURATION_MS,
  SESSION_SIGN_IN_CAP_MS,
  SIGN_IN_DURATION_MS,
  SignInDuration,
  type ClientGrantEntity,
} from '../../../../src/models/auth/grant.js';
import { UNKNOWN_CLIENT_NAME } from '../../../../src/models/auth/signIn.js';
import { AccessTokenKind, TOKEN_NAME_MAX_LENGTH } from '../../../../src/models/auth/token.js';

const HOUR_MS = 60 * 60 * 1000;

const READ = 'fintrack:read' as const;

const NOW = new Date('2026-10-11T12:00:00.000Z');

const MINUTE_MS = 60 * 1000;

const pendingGrant = (overrides: Partial<ClientGrantEntity> = {}): ClientGrantEntity => ({
  ...newGrant(
    {
      id: 'g1',
      deviceCodeHash: 'sha(device)',
      userCode: 'ABCDEFGH',
      input: {
        client: { name: 'Claude Desktop', version: '1.2.3' },
        profile: 'default',
        channel: GrantChannel.enum.stdio,
      },
    },
    NOW,
  ),
  version: 0,
  ...overrides,
});

const approved = (overrides: Partial<ClientGrantEntity> = {}): ClientGrantEntity => ({
  ...approvedGrant(
    pendingGrant(),
    { userId: 'user-owner', scopes: [READ], duration: SignInDuration.enum['24h'] },
    new Date(NOW.getTime() + MINUTE_MS),
  ),
  ...overrides,
});

const WRITE = 'fintrack:write' as const;

describe('signInExpiry — absolute from approval, never past the maximum', () => {
  const approvedAt = '2026-10-11T12:00:00.000Z';

  it.each([
    [SignInDuration.enum.session, 12 * HOUR_MS],
    [SignInDuration.enum['24h'], 24 * HOUR_MS],
    [SignInDuration.enum['7d'], 7 * 24 * HOUR_MS],
    [SignInDuration.enum['30d'], 30 * 24 * HOUR_MS],
  ])('%s lasts exactly its window from the approval instant', (duration, ms) => {
    expect(Date.parse(signInExpiry(approvedAt, duration)) - Date.parse(approvedAt)).toBe(ms);
  });

  it('keeps every duration within the 30-day maximum, and "this session" within its 12-hour cap', () => {
    for (const duration of SignInDuration.options) {
      expect(SIGN_IN_DURATION_MS[duration]).toBeLessThanOrEqual(MAX_SIGN_IN_DURATION_MS);
    }
    expect(SIGN_IN_DURATION_MS.session).toBe(SESSION_SIGN_IN_CAP_MS);
    expect(SESSION_SIGN_IN_CAP_MS).toBe(12 * HOUR_MS);
  });

  it('counts from the approval time given, not from the moment it is asked', () => {
    expect(signInExpiry('2026-01-01T00:00:00.000Z', SignInDuration.enum['24h'])).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('duration policy', () => {
  it('saves every duration to the keychain except "this session only"', () => {
    expect(persistsToKeychain(SignInDuration.enum.session)).toBe(false);
    for (const duration of ['24h', '7d', '30d'] as const) expect(persistsToKeychain(duration)).toBe(true);
  });

  it('offers "this session only" to a stdio client and never to `fintrack login`', () => {
    expect(durationAllowedFor(GrantChannel.enum.stdio, SignInDuration.enum.session)).toBe(true);
    expect(durationAllowedFor(GrantChannel.enum.cli, SignInDuration.enum.session)).toBe(false);
    expect(durationAllowedFor(GrantChannel.enum.cli, SignInDuration.enum['7d'])).toBe(true);
  });
});

describe('user codes', () => {
  it('shows eight symbols as XXXX-XXXX', () => {
    expect(formatUserCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('matches whatever a person typed — case, dashes, spaces — and fixes the look-alikes', () => {
    expect(normalizeUserCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeUserCode(' ab cd–ef gh ')).toBe('ABCDEFGH');
    expect(normalizeUserCode('O1Il-0000')).toBe('01110000');
  });
});

describe('grant state transitions', () => {
  it('starts pending with a ten-minute window and no approver, scopes or duration', () => {
    const grant = pendingGrant();
    expect(grant).toMatchObject({
      status: GrantStatus.enum.pending,
      userId: null,
      scopes: null,
      duration: null,
      approvedAt: null,
      clientName: 'Claude Desktop',
      clientVersion: '1.2.3',
      profile: 'default',
    });
    expect(Date.parse(grant.expiresAt) - NOW.getTime()).toBe(CLIENT_GRANT_TTL_MS);
    expect(CLIENT_GRANT_TTL_MS).toBe(10 * MINUTE_MS);
  });

  it('records what the asker would like pre-selected, if anything', () => {
    const hinted = newGrant(
      {
        id: 'g',
        deviceCodeHash: 'h',
        userCode: 'ABCDEFGH',
        input: {
          client: { name: 'fintrack login', version: '1' },
          profile: 'work',
          channel: GrantChannel.enum.cli,
          hint: { access: 'write', duration: SignInDuration.enum['7d'] },
        },
      },
      NOW,
    );
    expect(hinted).toMatchObject({ hintAccess: 'write', hintDuration: '7d', channel: 'cli' });
    expect(pendingGrant()).toMatchObject({ hintAccess: null, hintDuration: null });
  });

  it('approval binds the approving user, the chosen scopes and duration, and the approval time', () => {
    const grant = approved();
    expect(grant).toMatchObject({
      status: GrantStatus.enum.approved,
      userId: 'user-owner',
      scopes: [READ],
      duration: '24h',
      approvedAt: '2026-10-11T12:01:00.000Z',
    });
  });

  it('denies, redeems and expires by changing only the status', () => {
    expect(deniedGrant(pendingGrant()).status).toBe(GrantStatus.enum.denied);
    expect(redeemedGrant(approved()).status).toBe(GrantStatus.enum.redeemed);
    expect(expiredGrant(pendingGrant()).status).toBe(GrantStatus.enum.expired);
    expect(redeemedGrant(approved())).toMatchObject({ userId: 'user-owner', duration: '24h' });
  });

  it('is answerable only while pending and inside its window', () => {
    expect(isAnswerable(pendingGrant(), NOW)).toBe(true);
    expect(isAnswerable(pendingGrant(), new Date(NOW.getTime() + CLIENT_GRANT_TTL_MS - 1))).toBe(true);
    expect(isAnswerable(pendingGrant(), new Date(NOW.getTime() + CLIENT_GRANT_TTL_MS))).toBe(false);
    expect(isAnswerable(approved(), NOW)).toBe(false);
    expect(isAnswerable(deniedGrant(pendingGrant()), NOW)).toBe(false);
    expect(isAnswerable(null, NOW)).toBe(false);
  });

  it('describes a request to the approver with the code in its displayed form', () => {
    expect(grantRequestOf(pendingGrant())).toEqual({
      userCode: 'ABCD-EFGH',
      clientName: 'Claude Desktop',
      clientVersion: '1.2.3',
      profile: 'default',
      channel: 'stdio',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + CLIENT_GRANT_TTL_MS).toISOString(),
    });
  });
});

describe('redeemPlan', () => {
  it('knows nothing about an unknown device code, and a redeemed grant is spent', () => {
    expect(redeemPlan(null, NOW)).toEqual({ kind: 'invalid' });
    expect(redeemPlan(redeemedGrant(approved()), NOW)).toEqual({ kind: 'invalid' });
  });

  it('waits on a pending grant', () => {
    expect(redeemPlan(pendingGrant(), NOW)).toEqual({ kind: 'pending' });
  });

  it('reports a denial, which is terminal', () => {
    expect(redeemPlan(deniedGrant(pendingGrant()), NOW)).toEqual({ kind: 'denied' });
  });

  it('settles a grant that ran out while still open, once, and leaves an already-expired one alone', () => {
    const late = new Date(NOW.getTime() + CLIENT_GRANT_TTL_MS);
    expect(redeemPlan(pendingGrant(), late)).toEqual({ kind: 'expired', settle: expiredGrant(pendingGrant()) });
    expect(redeemPlan(approved(), late)).toEqual({ kind: 'expired', settle: expiredGrant(approved()) });
    expect(redeemPlan(expiredGrant(pendingGrant()), late)).toEqual({ kind: 'expired', settle: null });
  });

  it('mints for an approved grant inside its window', () => {
    const plan = redeemPlan(approved(), new Date(NOW.getTime() + 2 * MINUTE_MS));
    expect(plan.kind).toBe('mint');
  });

  it('refuses to mint from an approved grant that lost its approver, scopes, duration or time', () => {
    for (const hole of ['userId', 'scopes', 'duration', 'approvedAt'] as const) {
      expect(redeemPlan(approved({ [hole]: null }), NOW)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('consentChoice — what the form pre-selects', () => {
  const lastWrite = { scopes: [READ, WRITE], duration: SignInDuration.enum['7d'] };

  it('defaults to read-only for 24 hours', () => {
    expect(consentChoice(pendingGrant(), null)).toEqual({ access: 'read', duration: '24h' });
  });

  it('remembers the last choice for this client', () => {
    expect(consentChoice(pendingGrant(), lastWrite)).toEqual({ access: 'write', duration: '7d' });
    expect(consentChoice(pendingGrant(), { scopes: [READ], duration: SignInDuration.enum.session })).toEqual({
      access: 'read',
      duration: 'session',
    });
  });

  it('lets the asker’s hint win over the last choice', () => {
    const hinted = pendingGrant({ hintAccess: 'read', hintDuration: SignInDuration.enum['30d'] });
    expect(consentChoice(hinted, lastWrite)).toEqual({ access: 'read', duration: '30d' });
  });

  it('never pre-selects "this session only" for a grant that may not have it', () => {
    const cli = pendingGrant({ channel: GrantChannel.enum.cli });
    const rememberedSession = { scopes: [READ], duration: SignInDuration.enum.session };
    expect(consentChoice(cli, rememberedSession).duration).toBe('24h');
    expect(
      consentChoice(pendingGrant({ channel: GrantChannel.enum.cli, hintDuration: 'session' }), null).duration,
    ).toBe('24h');
  });
});

describe('the sign-in token a redeemed grant becomes', () => {
  const grant = (() => {
    const plan = redeemPlan(approved(), new Date(NOW.getTime() + 2 * MINUTE_MS));
    if (plan.kind !== 'mint') throw new Error('expected a mint plan');
    return plan.grant;
  })();

  it('is a stdio-kind token that carries the client, profile and scopes, and expires after the chosen duration', () => {
    const token = newStdioSignIn({ id: 't1', tokenHash: 'sha(x)', prefix: 'ftk_abcdef', grant }, NOW);
    expect(token).toMatchObject({
      kind: AccessTokenKind.enum.stdio,
      clientName: 'Claude Desktop',
      profile: 'default',
      scopes: [READ],
      lastUsedAt: null,
      revokedAt: null,
      name: 'Claude Desktop (default)',
    });
    // Counted from the approval (12:01), not from when the token was minted.
    expect(token.expiresAt).toBe('2026-10-12T12:01:00.000Z');
  });

  it.each(SignInDuration.options)('always has an expiry for %s — never null', (duration) => {
    const token = newStdioSignIn({ id: 't', tokenHash: 'h', prefix: 'p', grant: { ...grant, duration } }, NOW);
    expect(token.expiresAt).toBe(signInExpiry(grant.approvedAt, duration));
  });

  it('keeps its list name within the token name limit', () => {
    const long = { ...grant, clientName: 'C'.repeat(200) };
    const token = newStdioSignIn({ id: 't', tokenHash: 'h', prefix: 'p', grant: long }, NOW);
    expect(token.name.length).toBeLessThanOrEqual(TOKEN_NAME_MAX_LENGTH);
  });
});

describe('grantRequestOf never exposes secrets', () => {
  it('carries no hash or device code', () => {
    const request = grantRequestOf(pendingGrant());
    expect(JSON.stringify(request)).not.toContain('sha(device)');
    expect(request).not.toHaveProperty('deviceCodeHash');
  });
});

describe('supersededGrants — which redeemed grants no longer matter', () => {
  const redeemedAt = (
    id: string,
    approvedAt: string,
    overrides: Partial<ClientGrantEntity> = {},
  ): ClientGrantEntity => ({
    ...approved({ id, approvedAt, userId: 'user-owner', status: GrantStatus.enum.redeemed }),
    ...overrides,
  });

  it('keeps the newest approval per user, profile and client, and offers the older ones', () => {
    const grants = [
      redeemedAt('old', '2026-10-01T00:00:00.000Z'),
      redeemedAt('newest', '2026-10-03T00:00:00.000Z'),
      redeemedAt('middle', '2026-10-02T00:00:00.000Z'),
    ];
    expect(
      supersededGrants(grants)
        .map((grant) => grant.id)
        .sort(),
    ).toEqual(['middle', 'old']);
  });

  it('orders by approval, not by when the request was made', () => {
    const grants = [
      redeemedAt('requested-last-approved-first', '2026-10-01T00:00:00.000Z', {
        createdAt: '2026-10-09T00:00:00.000Z',
      }),
      redeemedAt('requested-first-approved-last', '2026-10-05T00:00:00.000Z', {
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    ];
    expect(supersededGrants(grants).map((grant) => grant.id)).toEqual(['requested-last-approved-first']);
  });

  it('breaks a tie on the same approval instant by id, the same way the repository orders', () => {
    const grants = [redeemedAt('a', '2026-10-01T00:00:00.000Z'), redeemedAt('b', '2026-10-01T00:00:00.000Z')];
    expect(supersededGrants(grants).map((grant) => grant.id)).toEqual(['a']);
    expect(supersededGrants([...grants].reverse()).map((grant) => grant.id)).toEqual(['a']);
  });

  it('keeps one per key: another profile, another client and another user each have their own', () => {
    const grants = [
      redeemedAt('a-old', '2026-10-01T00:00:00.000Z'),
      redeemedAt('a-new', '2026-10-02T00:00:00.000Z'),
      redeemedAt('work', '2026-10-01T00:00:00.000Z', { profile: 'work' }),
      redeemedAt('vscode', '2026-10-01T00:00:00.000Z', { clientName: 'VS Code' }),
      redeemedAt('ana', '2026-10-01T00:00:00.000Z', { userId: 'user-ana' }),
    ];
    expect(supersededGrants(grants).map((grant) => grant.id)).toEqual(['a-old']);
  });

  it('offers nothing when each key has a single grant, or none are given', () => {
    expect(supersededGrants([redeemedAt('only', '2026-10-01T00:00:00.000Z')])).toEqual([]);
    expect(supersededGrants([])).toEqual([]);
  });

  it('does not mistake keys whose parts would collide if joined by a separator', () => {
    const grants = [
      redeemedAt('x', '2026-10-01T00:00:00.000Z', { profile: 'a', clientName: 'b c' }),
      redeemedAt('y', '2026-10-02T00:00:00.000Z', { profile: 'a b', clientName: 'c' }),
    ];
    expect(supersededGrants(grants)).toEqual([]);
  });
});

describe('sessionOnlyLabel', () => {
  it('names the client that asked', () => {
    expect(sessionOnlyLabel('Claude Desktop')).toBe('This Claude Desktop session only');
  });

  it('falls back to a plain label for the unknown-client placeholder', () => {
    expect(sessionOnlyLabel(UNKNOWN_CLIENT_NAME)).toBe('This session only');
  });
});
