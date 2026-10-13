#!/usr/bin/env node
import type { Result } from 'neverthrow';
import { isPortInUse, portInUseMessage } from './common/net.js';
import { loadConfig, McpTransport } from './config.js';
import { databaseAheadMessage, type DatabaseAhead } from './models/database.js';

// Each flow is a composition module, loaded only when it runs: the CLI never pays for a server, a stdio start never
// loads Fastify (the stdio module loads it itself only when the sidecar is on), and an HTTP start never loads the CLI.
const loadCliModule = () => import('./composition/cli.js');
const loadStdioModule = () => import('./composition/stdio.js');
const loadHttpModule = () => import('./composition/http.js');

/** A database a newer build has migrated: the complete diagnosis, no stack trace, exit 1. */
const refuseIfAhead = (started: Result<void, DatabaseAhead>): void => {
  if (started.isOk()) return;
  console.error(databaseAheadMessage(started.error.version));
  process.exit(1);
};

const main = async (): Promise<void> => {
  // Any argument is a command: an unknown one is a usage error, never a reason to start a server.
  if (process.argv.length > 2) {
    const { runCommandLine } = await loadCliModule();
    // Not process.exit: let the event loop drain, so everything the command printed has been flushed.
    process.exitCode = await runCommandLine(process.argv.slice(2));
    return;
  }

  const config = loadConfig();
  if (config.MCP_TRANSPORT === McpTransport.enum.stdio) {
    const { runStdio } = await loadStdioModule();
    return refuseIfAhead(await runStdio(config));
  }
  const { runHttp } = await loadHttpModule();
  return refuseIfAhead(await runHttp(config));
};

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    console.error(portInUseMessage(e));
    process.exit(1);
  }
  // Already a complete, actionable diagnosis — a stack trace would only bury it.
  console.error(e);
  process.exit(1);
});
