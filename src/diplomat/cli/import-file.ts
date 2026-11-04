import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { err, ok, Result } from 'neverthrow';
import { decodeKeyFile } from '../../logic/key-import.js';
import { isDatabaseFile } from '../../logic/export-destination.js';
import { reasonOf } from '../../models/error.js';
import { DATA_BEARING_SUFFIXES, DATABASE_COMPANION_SUFFIXES } from '../../models/export.js';
import { KEY_FILE_MAX_CHARACTERS } from '../../models/key-import.js';
import { realPath, statLink } from './export-file.js';
import type { Importer } from './io.js';
import { CLI_MESSAGES } from './messages.js';

const statFile = Result.fromThrowable((path: string) => statSync(path), reasonOf);
const readText = Result.fromThrowable((path: string): string => readFileSync(path, 'utf8'), reasonOf);

/** The file to import, as a real path: it must exist and be a regular file (a symlink to one is fine — that is how a
 *  Docker secret is mounted). */
const sourceFile = (from: string): Result<string, string> => {
  const requested = resolve(from);
  const isFile = statFile(requested).match(
    (stat) => stat.isFile(),
    () => false,
  );
  return isFile
    ? realPath(requested).mapErr(() => CLI_MESSAGES.importSourceMissing(requested))
    : err(CLI_MESSAGES.importSourceMissing(requested));
};

/** The key in a key file, read whole only when it is small enough to be one. The key is returned to the caller and
 *  nowhere else: an invalid file is reported without its contents. */
export const keyFromFile = (from: string): Result<string, string> =>
  sourceFile(from).andThen((file) =>
    statFile(file)
      .mapErr(() => CLI_MESSAGES.importSourceUnreadable(file))
      .andThen((stat) => (stat.size > KEY_FILE_MAX_CHARACTERS ? err(CLI_MESSAGES.keyFileInvalid) : ok(file)))
      .andThen((small) => readText(small).mapErr(() => CLI_MESSAGES.importSourceUnreadable(small)))
      .andThen((contents) => {
        const key = decodeKeyFile(contents);
        return key === null ? err(CLI_MESSAGES.keyFileInvalid) : ok(key);
      }),
  );

const firstExisting = (base: string, suffixes: readonly string[]): string | undefined =>
  suffixes.map((suffix) => `${base}${suffix}`).find((path) => statLink(path).isOk());

/** Why `file` may not become the database at `target`, or null. In order: it is the live database, something is
 *  already at `target` (a dangling symlink counts), the source is not standalone (a `-wal` or `-journal` beside it
 *  holds data it would not carry), or a leftover companion of `target` would be replayed on the copy. */
const importRefusal = (file: string, target: string): string | null => {
  const live = realPath(target).orElse(() => ok(target));
  if (live.isOk() && isDatabaseFile(live.value, file)) return CLI_MESSAGES.snapshotIsDatabase(file);
  if (statLink(target).isOk()) return CLI_MESSAGES.databaseExists(target);
  if (firstExisting(file, DATA_BEARING_SUFFIXES) !== undefined) return CLI_MESSAGES.snapshotNotStandalone(file);
  if (firstExisting(target, DATABASE_COMPANION_SUFFIXES) !== undefined) return CLI_MESSAGES.databaseLeftovers(target);
  return null;
};

/** A snapshot may be imported when it is a standalone file other than the database itself and nothing is at, or left
 *  beside, `DB_PATH`. Decided before anything is opened. `wx` at the copy is the backstop for a race. */
export const snapshotSource = (importer: Importer, from: string): Result<string, string> =>
  sourceFile(from).andThen((file) => {
    const refusal = importRefusal(file, importer.databasePath());
    return refusal === null ? ok(file) : err(refusal);
  });
