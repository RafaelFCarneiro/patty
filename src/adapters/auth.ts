import type { FlowOutcome } from '@rfc0/effect-runner';
import * as sessionAdapters from './sessions.js';
import * as setupCodeAdapters from './setupCodes.js';
import * as userAdapters from './users.js';

/** The auth flows touch three entities; each adapter only rewrites its own tag, so applying all three
 *  in turn adapts a mixed batch (`claimOwner`: user + setup code + session). */
export const outcomeToDb = <T>(outcome: FlowOutcome<T>): FlowOutcome<T> =>
  sessionAdapters.outcomeToDb(setupCodeAdapters.outcomeToDb(userAdapters.outcomeToDb(outcome)));
