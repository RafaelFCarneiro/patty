import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/** A copy of the real migrations whose journal stops just before `tag`: a database as an earlier release left it.
 *  Returns the copied folder (inside `root`). A tag that is not in the journal throws, so a misspelt one fails the
 *  test instead of silently migrating everything. */
export const migrationsBefore = (root: string, tag: string): string => {
  const folder = join(root, `migrations-before-${tag}`);
  cpSync(REAL_MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === tag);
  if (cutoff === -1) throw new Error(`${tag} is not in ${journalPath}`);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, cutoff) }, null, 2));
  return folder;
};
