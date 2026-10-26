import { databaseAheadMessage, DatabaseAheadCode, type DatabaseAhead } from './database.js';
import { demoNotReadyMessage, DemoNotReadyCode, type DemoNotReady } from './demo.js';

export type StartupRefusal = DatabaseAhead | DemoNotReady;

type Messages = { [C in StartupRefusal['code']]: (refusal: Extract<StartupRefusal, { code: C }>) => string };

const MESSAGES: Messages = {
  [DatabaseAheadCode.enum.database_ahead]: ({ version }) => databaseAheadMessage(version),
  [DemoNotReadyCode.enum.demo_not_ready]: demoNotReadyMessage,
};

export const startupRefusalMessage = (refusal: StartupRefusal): string =>
  (MESSAGES[refusal.code] as (refusal: StartupRefusal) => string)(refusal);
