#!/usr/bin/env node
import { DatabaseAheadError } from './common/databaseAhead.js';
import { isPortInUse, portInUseMessage } from './common/net.js';
import { loadConfig, McpTransport } from './config.js';

// Each flow is a composition module, loaded only when it runs: the CLI never pays for a server, a stdio start never
// loads Fastify (the stdio module loads it itself only when the sidecar is on), and an HTTP start never loads the CLI.
const loadCliModule = () => import('./diplomat/cli/commands.js');
const loadCliCompositionModule = () => import('./composition/cli.js');
const loadStdioModule = () => import('./composition/stdio.js');
const loadHttpModule = () => import('./composition/http.js');

const main = async (): Promise<void> => {
  // Any argument is a command: an unknown one is a usage error, never a reason to start a server.
  if (process.argv.length > 2) {
    const { runCli } = await loadCliModule();
    const { defaultCliIo } = await loadCliCompositionModule();
    // Not process.exit: let the event loop drain, so everything the command printed has been flushed.
    process.exitCode = await runCli(process.argv.slice(2), defaultCliIo());
    return;
  }

  const config = loadConfig();
  if (config.MCP_TRANSPORT === McpTransport.enum.stdio) {
    const { runStdio } = await loadStdioModule();
    await runStdio(config);
    return;
  }
  const { runHttp } = await loadHttpModule();
  await runHttp(config);
};

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    console.error(portInUseMessage(e));
    process.exit(1);
  }
  // Already a complete, actionable diagnosis — a stack trace would only bury it.
  console.error(e instanceof DatabaseAheadError ? e.message : e);
  process.exit(1);
});
