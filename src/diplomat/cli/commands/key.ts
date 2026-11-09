import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { errAsync, okAsync, Result, ResultAsync } from 'neverthrow';
import { reasonOf } from '../../../models/error.js';
import { EXCLUSIVE_CREATE_FLAG, PRIVATE_FILE_MODE } from '../../../models/export.js';
import { NPX_COMMAND } from '../../../models/package.js';
import { keyImportRefusal } from '../../../logic/key-import.js';
import {
  EXPORT_FLAGS,
  EXPORT_POSITIONALS,
  ExportOptionsSchema,
  IMPORT_FLAGS,
  IMPORT_POSITIONALS,
  ImportOptionsSchema,
  KeySubcommand,
} from '../../../wire/in/cli.js';
import { keyDestination } from '../export-file.js';
import { keyFromFile } from '../import-file.js';
import { EXIT_OK, exitCodeOf, fail, failed, parseFlags, refuseUnknownSubcommand, type CliIo, type Importer } from '../io.js';
import { CLI_MESSAGES } from '../messages.js';

export const KEY_HELP = `
Usage: ${NPX_COMMAND} key <command>

Commands:
  export --to <file>     Write the database encryption key to a new file, usable as PATTY_DB_KEY_FILE
  import --from <file>   Store a key written by \`export\` in the OS keychain, where this install reads it

Export: the file is created owner-only and never overwritten, and must not be in the database's directory. The key is
written only there: it is never printed. Run it from the terminal that holds the key, before moving the database.

Import: refused when the keychain already holds a key (remove that entry yourself first) and when PATTY_DB_KEY_FILE
or PATTY_DB_KEY is set (those installs read the key from there). When a database already exists here, the key must
open it. To move to this machine: key import first, then db import, then setup <client>.
`.trimStart();

/** One line, the key and a newline: what `PATTY_DB_KEY_FILE` reads back exactly. A half-written file is removed. */
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

const checkKeySources = (importer: Importer): ResultAsync<void, string> =>
  new ResultAsync(importer.keySources()).andThen((sources) => {
    const refusal = keyImportRefusal(sources);
    return refusal === null ? okAsync(undefined) : errAsync(CLI_MESSAGES.keyImportRefused(refusal));
  });

const importKey = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, IMPORT_FLAGS, ImportOptionsSchema, IMPORT_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const { importer } = io;
  const stored = await keyFromFile(parsed.options.from)
    .asyncAndThen((key) =>
      checkKeySources(importer)
        .andThen(() => new ResultAsync(importer.proveAgainstDatabase(key)))
        .andThen(() => new ResultAsync(importer.storeKey(key))),
    );
  if (stored.isErr()) return failed(io, stored.error);
  io.out(CLI_MESSAGES.keyImported());
  return EXIT_OK;
};

const KEY_RUNNERS = {
  export: exportKey,
  import: importKey,
} as const satisfies Record<KeySubcommand, (args: readonly string[], io: CliIo) => Promise<number>>;

export const runKeyCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const [name, ...rest] = args;
  if (name === undefined) {
    io.out(KEY_HELP);
    return EXIT_OK;
  }
  const known = KeySubcommand.safeParse(name);
  if (!known.success) return refuseUnknownSubcommand(io, 'key', name, KEY_HELP);
  return KEY_RUNNERS[known.data](rest, io);
};
