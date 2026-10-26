#!/usr/bin/env node
import type { Result } from 'neverthrow';
import { isPortInUse, portInUseMessage } from './common/net.js';
import { loadHttpModule } from './composition/lazy-modules.js';
import { loadConfig, McpTransport } from './config.js';
import { startupRefusalMessage, type StartupRefusal } from './models/startup.js';

// Each flow is a composition module, loaded only when it runs: the CLI never pays for a server, a stdio start never
// loads Fastify (the stdio module loads it itself only when the sidecar is on), and an HTTP start never loads the CLI.
const loadCliModule = () => import('./composition/cli.js');
const loadStdioModule = () => import('./composition/stdio.js');

/** The exit status of a process that could not start. */
const EXIT_FAILURE = 1;

/** A refused start (a database a newer build migrated, a demo that is not one): the complete diagnosis, no stack
 *  trace, exit 1. */
const refuseIfNotStarted = (started: Result<void, StartupRefusal>): void => {
  if (started.isOk()) return;
  console.error(startupRefusalMessage(started.error));
  process.exit(EXIT_FAILURE);
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
    return refuseIfNotStarted(await runStdio(config));
  }
  const { runHttp } = await loadHttpModule();
  return refuseIfNotStarted(await runHttp(config));
};

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    console.error(portInUseMessage(e));
    process.exit(EXIT_FAILURE);
  }
  // Only unexpected errors get here (a refused start is a Result, handled above): the stack is the diagnosis.
  console.error(e);
  process.exit(EXIT_FAILURE);
});
