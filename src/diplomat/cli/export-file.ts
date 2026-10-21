import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { err, ok, Result } from 'neverthrow';
import { isBesideData, isDatabaseFile } from '../../logic/export-destination.js';
import { reasonOf } from '../../models/error.js';
import type { Exporter } from './io.js';
import { CLI_MESSAGES } from './messages.js';

const realPath = Result.fromThrowable((path: string): string => realpathSync.native(path), reasonOf);
const statLink = Result.fromThrowable(lstatSync, reasonOf);

type Located = { destination: string; directory: string };

/** The destination as the filesystem sees it: its directory resolved through symlinks and relative segments, so a
 *  rule applied to it cannot be slipped past with a `..` or a link. The file itself is not followed. */
const locate = (to: string): Result<Located, string> => {
  const requested = resolve(to);
  return realPath(dirname(requested))
    .mapErr(() => CLI_MESSAGES.destinationDirectoryMissing(requested))
    .map((directory) => ({ destination: join(directory, basename(requested)), directory }));
};

/** An existing file is never overwritten — a dangling symlink counts as existing. `wx` is the backstop for a race. */
const refuseExisting = ({ destination }: Located): Result<string, string> =>
  statLink(destination).isOk() ? err(CLI_MESSAGES.destinationExists(destination)) : ok(destination);

/** Where the key may be written: a new file, in a directory that is not the database's (nor under it). */
export const keyDestination = (exporter: Exporter, to: string): Result<string, string> =>
  locate(to).andThen((located) =>
    realPath(dirname(exporter.databasePath()))
      .mapErr(() => CLI_MESSAGES.destinationDirectoryMissing(exporter.databasePath()))
      .andThen((dataDirectory) =>
        isBesideData(dataDirectory, located.directory)
          ? err(CLI_MESSAGES.keyBesideData(located.directory))
          : ok(located),
      )
      .andThen(refuseExisting),
  );

/** Where a snapshot may be written: a new file that is not the live database. */
export const snapshotDestination = (exporter: Exporter, to: string): Result<string, string> =>
  locate(to).andThen((located) =>
    realPath(exporter.databasePath())
      .orElse(() => ok(exporter.databasePath()))
      .andThen((databaseFile) =>
        isDatabaseFile(databaseFile, located.destination)
          ? err(CLI_MESSAGES.snapshotIsDatabase(located.destination))
          : ok(located),
      )
      .andThen(refuseExisting),
  );
