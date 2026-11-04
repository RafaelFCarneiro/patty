/** Every file FinTrack writes for the person to carry elsewhere (the safety copy, `key export`, `db export`) is
 *  created owner-only and never over an existing file. */
export const PRIVATE_FILE_MODE = 0o600;

/** `open(2)` flags: create the file, failing if anything is already there (a symlink included). */
export const EXCLUSIVE_CREATE_FLAG = 'wx';

/** Rows of the owned tables a `db export` reports, so the person can compare them after the move. Counts only. */
export type ExportedRowCounts = Readonly<Record<string, number>>;

/** Files SQLite leaves beside a database. */
export const DATABASE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** The companions that hold data: a database file with one beside it is not complete on its own. */
export const DATA_BEARING_SUFFIXES = ['-wal', '-journal'] as const;

/** The `code` of the error `open(2)` raises when `EXCLUSIVE_CREATE_FLAG` finds the file already there. */
export const FILE_EXISTS_CODE = 'EEXIST';

/** The data directory, and anything created to hold the database, is the owner's alone. */
export const PRIVATE_DIRECTORY_MODE = 0o700;
