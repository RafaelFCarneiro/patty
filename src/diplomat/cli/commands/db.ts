import { errAsync, ResultAsync } from 'neverthrow';
import type { ExportedRowCounts, StagedCopy } from '../../../models/export.js';
import { NPX_COMMAND } from '../../../models/package.js';
import {
  DbSubcommand,
  EXPORT_FLAGS,
  EXPORT_POSITIONALS,
  ExportOptionsSchema,
  IMPORT_FLAGS,
  IMPORT_POSITIONALS,
  ImportOptionsSchema,
} from '../../../wire/in/cli.js';
import { snapshotDestination } from '../export-file.js';
import { snapshotSource } from '../import-file.js';
import {
  EXIT_OK,
  exitCodeOf,
  fail,
  failed,
  parseFlags,
  refuseUnknownSubcommand,
  type CliIo,
  type Importer,
} from '../io.js';
import { CLI_MESSAGES } from '../messages.js';

export const DB_HELP = `
Usage: ${NPX_COMMAND} db <command>

Commands:
  export --to <file>     Write a consistent, still-encrypted snapshot of the database to a new file
  import --from <file>   Put a snapshot written by \`export\` in place as this install's database

Export: the snapshot is created owner-only and never overwritten, is complete on its own (no -wal file) and opens with
the same key. It is safe to take while FinTrack is running, but stop every client first so nothing is written after
it. The database is opened as it is: nothing is migrated. Prints row counts (no data) to compare after a move.

Import: refused when a database already exists here, and when the snapshot does not open with this install's key (file,
env var or keychain; one is never generated). The copy is created owner-only and never overwrites; nothing is
migrated, the next start does that after its usual safety copy. Prints the same row counts as export.
To move to this machine: key import first, then db import, then setup <client>.
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

const publishChecked = (importer: Importer, staged: StagedCopy, key: string): ResultAsync<ExportedRowCounts, string> =>
  new ResultAsync(importer.inspectSnapshot(staged, key))
    .andThen((counts) => new ResultAsync(importer.publishSnapshot(staged)).map(() => counts))
    .orElse((failure) => {
      importer.discardSnapshot(staged);
      return errAsync(failure);
    });

const importSnapshot = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, IMPORT_FLAGS, ImportOptionsSchema, IMPORT_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const { importer } = io;
  const source = snapshotSource(importer, parsed.options.from);
  if (source.isErr()) return failed(io, source.error);
  const { file, target } = source.value;
  const imported = await new ResultAsync(importer.resolveKey()).andThen((key) =>
    new ResultAsync(importer.stageSnapshot(file)).andThen((staged) => publishChecked(importer, staged, key)),
  );
  if (imported.isErr()) return failed(io, imported.error);
  io.out(CLI_MESSAGES.snapshotImported(target, imported.value));
  return EXIT_OK;
};

const DB_RUNNERS = {
  export: exportSnapshot,
  import: importSnapshot,
} as const satisfies Record<DbSubcommand, (args: readonly string[], io: CliIo) => Promise<number>>;

export const runDbCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const [name, ...rest] = args;
  if (name === undefined) {
    io.out(DB_HELP);
    return EXIT_OK;
  }
  const known = DbSubcommand.safeParse(name);
  if (!known.success) return refuseUnknownSubcommand(io, 'db', name, DB_HELP);
  return DB_RUNNERS[known.data](rest, io);
};
