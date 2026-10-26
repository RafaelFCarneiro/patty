import { isDemoInstance, type InstanceKind } from '../../models/instance.js';

export const MCP_SERVER_NAME = 'fintrack';

/** What a client is told when it connects to a demo database. The `fintrack` server name is the real install's. */
export const DEMO_SERVER_INSTRUCTIONS =
  "This FinTrack server is a DEMO: its data is sample data, not the person's finances. " +
  'Say so once, when you start working with it. Never record, import or change anything here as if it were the ' +
  `person's real money; for their real finances use the \`${MCP_SERVER_NAME}\` server instead.`;

/** Sent at initialize only for a demo database; a standard one sends none. */
export const serverInstructions = (kind: InstanceKind): string | undefined =>
  isDemoInstance(kind) ? DEMO_SERVER_INSTRUCTIONS : undefined;
