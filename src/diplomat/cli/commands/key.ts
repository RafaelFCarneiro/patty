import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { Result } from 'neverthrow';
import { reasonOf } from '../../../models/error.js';
import { EXCLUSIVE_CREATE_FLAG, PRIVATE_FILE_MODE } from '../../../models/export.js';
import { NPX_COMMAND } from '../../../models/package.js';
import { EXPORT_FLAGS, EXPORT_POSITIONALS, ExportOptionsSchema, KeySubcommand } from '../../../wire/in/cli.js';
import { keyDestination } from '../export-file.js';
import { EXIT_OK, exitCodeOf, fail, failed, parseFlags, refuseUnknownSubcommand, type CliIo } from '../io.js';
import { CLI_MESSAGES } from '../messages.js';

export const KEY_HELP = `
Usage: ${NPX_COMMAND} key <command>

Commands:
  export --to <file>   Write the database encryption key to a new file, usable as FINTRACK_DB_KEY_FILE

The file is created owner-only and never overwritten, and must not be in the database's directory. The key is written
only there: it is never printed. Run it from the terminal that holds the key, before moving the database to Docker.
`.trimStart();

/** One line, the key and a newline: what `FINTRACK_DB_KEY_FILE` reads back exactly. A half-written file is removed. */
const writeKeyFile = Result.fromThrowable((path: string, key: string): void => {
  const file = openSync(path, EXCLUSIVE_CREATE_FLAG, PRIVATE_FILE_MODE);
  try {
    writeFileSync(file, `${key}\n`); // writes it all or throws; writeSync may stop short
  } catch (cause) {
    rmSync(path, { force: true });
    throw cause;
  } finally {
    closeSync(file);
  }
}, reasonOf);

const exportKey = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, EXPORT_FLAGS, ExportOptionsSchema, EXPORT_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const destination = keyDestination(io.exporter, parsed.options.to);
  if (destination.isErr()) return failed(io, destination.error);
  const key = await io.exporter.provenKey();
  if (key.isErr()) return failed(io, key.error);
  const written = writeKeyFile(destination.value, key.value);
  if (written.isErr()) return failed(io, written.error);
  io.out(CLI_MESSAGES.keyExported(destination.value));
  return EXIT_OK;
};

export const runKeyCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const [name, ...rest] = args;
  if (name === undefined) {
    io.out(KEY_HELP);
    return EXIT_OK;
  }
  if (!KeySubcommand.safeParse(name).success) return refuseUnknownSubcommand(io, 'key', name, KEY_HELP);
  return exportKey(rest, io);
};
