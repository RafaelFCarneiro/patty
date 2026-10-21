import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Resolved relative to this module's own file location (not process.cwd()) so it works
// identically under `tsx src/...` (dev) and `node dist/...` (published package) — same pattern as
// diplomat/db/bootstrap.ts's DEFAULT_MIGRATIONS_FOLDER. src/diplomat/http/ui-files.ts and its
// compiled dist/diplomat/http/ui-files.js are both 3 levels below the package root.
export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

export const UI_ROOT = fileURLToPath(new URL('../../../ui', import.meta.url));

// The files under ui/ are fixed package assets — never rewritten at runtime — so the first read of
// each is cached in memory for the life of the process; only a *successful* read is cached (never
// a rejected promise), so a transient read error doesn't wedge every later request into repeating
// the same failure. `cache-control: no-cache` governs the browser's cache, not this one.
const fileContentCache = new Map<string, string>();

export const readCached = async (path: string): Promise<string> => {
  const cached = fileContentCache.get(path);
  if (cached !== undefined) return cached;
  const content = await readFile(path, 'utf-8');
  fileContentCache.set(path, content);
  return content;
};
