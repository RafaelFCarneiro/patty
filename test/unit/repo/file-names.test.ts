import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CHECKED_ROOTS = ['src', 'test', 'ui', 'scripts'];
const KEBAB_CASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*$/;

/** Names a tool or runner owns: vitest writes snapshots into `__snapshots__`. */
const EXCEPTIONS: ReadonlySet<string> = new Set(['__snapshots__']);

const pathsUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [path, ...pathsUnder(path)] : [path];
  });

const isKebabCase = (path: string): boolean =>
  path.split(sep).every((name) => EXCEPTIONS.has(name) || KEBAB_CASE_NAME.test(name));

describe('file and folder names', () => {
  it('are kebab-case', () => {
    const offenders = CHECKED_ROOTS.flatMap((root) => {
      try {
        return pathsUnder(join(ROOT, root));
      } catch {
        return [];
      }
    })
      .map((path) => relative(ROOT, path))
      .filter((path) => !isKebabCase(path));

    expect(offenders, `rename to kebab-case:\n${offenders.join('\n')}`).toEqual([]);
  });
});
