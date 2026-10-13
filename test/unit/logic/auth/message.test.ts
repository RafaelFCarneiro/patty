import { describe, expect, it } from 'vitest';
import { notSignedInMessage, setupBanner } from '../../../../src/logic/auth/message.js';
import { connectUrl } from '../../../../src/logic/auth/origin.js';
import { STDIO_MESSAGES, TERMINAL_SETUP_HINT } from '../../../../src/models/auth/message.js';
import { NPX_COMMAND } from '../../../../src/models/package.js';

describe('setupBanner', () => {
  it('shows the code, where to use it and when it expires', () => {
    const banner = setupBanner({
      code: 'ABCD-EFGH-JKMN-PQRS-TVWX',
      setupUrl: 'http://127.0.0.1:51737/ui/setup',
      expiresAt: '2026-10-07T12:30:00.000Z',
    });
    expect(banner).toContain('ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(banner).toContain('http://127.0.0.1:51737/ui/setup');
    expect(banner).toContain('2026-10-07T12:30:00.000Z');
  });

  it('also names the terminal route, from the shared constant', () => {
    const banner = setupBanner({ code: 'ABCD', setupUrl: 'http://127.0.0.1:51737/ui/setup', expiresAt: 'later' });
    expect(banner).toContain(TERMINAL_SETUP_HINT);
    expect(TERMINAL_SETUP_HINT).toBe('or run `npx @rafaelfcarneiro/fintrack@latest auth setup` in a terminal');
  });
});

describe('notSignedInMessage', () => {
  const ORIGIN = 'http://127.0.0.1:51737';

  it('names the link and the code, and nothing but the user code travels in the URL', () => {
    const message = notSignedInMessage({ origin: ORIGIN, userCode: 'ABCD-EFGH', ownerUnclaimed: false });
    expect(message).toBe(
      'FinTrack: not signed in. Open http://127.0.0.1:51737/ui/connect?code=ABCD-EFGH and confirm the code ABCD-EFGH.',
    );
    expect(connectUrl(ORIGIN, 'ABCD-EFGH')).toBe('http://127.0.0.1:51737/ui/connect?code=ABCD-EFGH');
  });

  it('points an unclaimed owner at the pinned setup command', () => {
    const message = notSignedInMessage({ origin: ORIGIN, userCode: 'ABCD-EFGH', ownerUnclaimed: true });
    expect(message).toContain(`Owner not set up yet? Run \`${NPX_COMMAND} auth setup\`.`);
    expect(NPX_COMMAND).toBe('npx @rafaelfcarneiro/fintrack@latest');
  });

  it('without an HTTP server says to log in from a terminal or set FINTRACK_TOKEN, with no link', () => {
    const message = notSignedInMessage({ origin: null, userCode: null, ownerUnclaimed: false });
    expect(message).toBe(STDIO_MESSAGES.notSignedInWithoutHttp);
    expect(message).toContain(`${NPX_COMMAND} login`);
    expect(message).toContain('FINTRACK_TOKEN');
    expect(message).not.toContain('/ui/connect');
  });

  it('has no unpinned npx command in any of its wording', () => {
    const wording = [
      STDIO_MESSAGES.notSignedInWithoutHttp,
      STDIO_MESSAGES.ownerUnclaimedHint,
      STDIO_MESSAGES.invalidEnvToken,
    ].join('\n');
    for (const [command] of wording.matchAll(/npx [^\s`]+/g))
      expect(command).toBe('npx @rafaelfcarneiro/fintrack@latest');
  });
});
