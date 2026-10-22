import { NPX_COMMAND } from '../../../models/package.js';
import { DbSubcommand, EXPORT_FLAGS, EXPORT_POSITIONALS, ExportOptionsSchema } from '../../../wire/in/cli.js';
import { snapshotDestination } from '../export-file.js';
import { EXIT_OK, exitCodeOf, fail, failed, parseFlags, refuseUnknownSubcommand, type CliIo } from '../io.js';
import { CLI_MESSAGES } from '../messages.js';

export const DB_HELP = `
Usage: ${NPX_COMMAND} db <command>

Commands:
  export --to <file>   Write a consistent, still-encrypted snapshot of the database to a new file

The snapshot is created owner-only and never overwritten, is complete on its own (no -wal file) and opens with the same
key. It is safe to take while FinTrack is running, but stop every client first so nothing is written after it. The
database is opened as it is: nothing is migrated. Prints row counts (no data) to compare after a move to Docker.
`.trimStart();

const exportSnapshot = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, EXPORT_FLAGS, ExportOptionsSchema, EXPORT_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const destination = snapshotDestination(io.exporter, parsed.options.to);
  if (destination.isErr()) return failed(io, destination.error);
  const counts = await io.exporter.writeSnapshot(destination.value);
  if (counts.isErr()) return failed(io, counts.error);
  io.out(CLI_MESSAGES.snapshotExported(destination.value, counts.value));
  return EXIT_OK;
};

export const runDbCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const [name, ...rest] = args;
  if (name === undefined) {
    io.out(DB_HELP);
    return EXIT_OK;
  }
  if (!DbSubcommand.safeParse(name).success) return refuseUnknownSubcommand(io, 'db', name, DB_HELP);
  return exportSnapshot(rest, io);
};
