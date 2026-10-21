/** Every file FinTrack writes for the person to carry elsewhere (the safety copy, `key export`, `db export`) is
 *  created owner-only and never over an existing file. */
export const PRIVATE_FILE_MODE = 0o600;

/** `open(2)` flags: create the file, failing if anything is already there (a symlink included). */
export const EXCLUSIVE_CREATE_FLAG = 'wx';

/** Rows of the owned tables a `db export` reports, so the person can compare them after the move. Counts only. */
export type ExportedRowCounts = Readonly<Record<string, number>>;
