import type { FlowOutcome } from '@rfc0/effect-runner';
import * as accessTokenAdapters from './accessTokens.js';
import * as clientGrantAdapters from './clientGrants.js';
import * as instanceSettingsAdapters from './instanceSettings.js';
import * as inviteAdapters from './invites.js';
import * as sessionAdapters from './sessions.js';
import * as setupCodeAdapters from './setupCodes.js';
import * as userAdapters from './users.js';

/** The auth flows touch seven entities; each adapter only rewrites its own tag, so applying all seven
 *  in turn adapts a mixed batch (`claimOwner`: user + setup code + session; `redeemGrant`: grant + token;
 *  `inviteUser`: user + invite). */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> =>
  instanceSettingsAdapters.outcomeToDb(
    inviteAdapters.outcomeToDb(
      clientGrantAdapters.outcomeToDb(
        accessTokenAdapters.outcomeToDb(
          sessionAdapters.outcomeToDb(setupCodeAdapters.outcomeToDb(userAdapters.outcomeToDb(outcome))),
        ),
      ),
    ),
  );
