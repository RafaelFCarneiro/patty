import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NPX_COMMAND, PACKAGE_NAME, PACKAGE_SPEC } from '../../../src/models/package.js';

/**
 * `npx` prefers an installed copy over the registry's when it is given no version, so an unpinned command can run a
 * stale (global) build against a newer database. Every command PATTY prints or documents is `@latest`-pinned
 * (ADR-034 §7); ADRs are history and are left as written.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const UNPINNED_SOURCE = `npx (?:-y )?${PACKAGE_NAME.replace(/[/@]/g, '\\$&')}(?!@)`;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|html)$/.test(entry.name) ? [path] : [];
  });

const DOCS = readdirSync(join(ROOT, 'docs'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => join('docs', name));
const USER_FACING = ['README.md', 'CLAUDE.md', join('.github', 'copilot-instructions.md'), ...DOCS];

describe('pinned npx commands', () => {
  it('builds the command from one constant', () => {
    expect(PACKAGE_SPEC).toBe('@rfc0/patty@latest');
    expect(NPX_COMMAND).toBe('npx @rfc0/patty@latest');
  });

  it.each(USER_FACING)('has no unpinned npx command in %s', (path) => {
    expect(read(path).match(new RegExp(UNPINNED_SOURCE, 'g')) ?? []).toEqual([]);
  });

  it('has none in the source or the pages either', () => {
    const unpinned = new RegExp(UNPINNED_SOURCE);
    const offenders = [...sourceFiles('src'), ...sourceFiles('ui')].filter((path) => unpinned.test(read(path)));
    expect(offenders).toEqual([]);
  });

  it('has no `npx ${PACKAGE_NAME}` template left to print one', () => {
    const offenders = sourceFiles('src').filter((path) => read(path).includes('npx ${PACKAGE_NAME}'));
    expect(offenders).toEqual([]);
  });
});
