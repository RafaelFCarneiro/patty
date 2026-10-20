import type { Persistable, FlowOutcome } from '@rfc0/effect-runner';

export type EntityDbAdapter = {
  persistableToDb: (p: Persistable) => Persistable;
  outcomeToDb: <T>(outcome: FlowOutcome<T>) => FlowOutcome<T>;
};
