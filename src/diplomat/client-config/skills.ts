import { existsSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, Result } from 'neverthrow';
import * as R from 'remeda';
import type { ClientSetupReport, ClientSetupResult } from '../../controllers/deps.js';
import {
  clientConfigFailures,
  leftUnchangedNotOwn,
  SKILL_POINTER_MARKER,
  SKILL_POINTERS,
  type ClientConfigFailure,
  type SkillOutcome,
  type SkillPointer,
} from '../../models/client-config.js';
import { readText, writeText } from './fs.js';

/** The packaged skills, resolved from this module (not the working directory), 3 levels below the package root. */
export const SKILLS_ROOT = fileURLToPath(new URL('../../../skills', import.meta.url));

const SKILL_FILE = 'SKILL.md';

const fileOf = (root: string, { installDirectory }: SkillPointer): string => join(root, installDirectory, SKILL_FILE);

const isPattyOwn = (content: string): boolean => content.split(/\r?\n/).includes(SKILL_POINTER_MARKER);

const installOne = (root: string, pointer: SkillPointer): SkillOutcome => {
  const target = fileOf(root, pointer);
  const existing: Result<string | null, unknown> = existsSync(target) ? readText(target) : ok(null);
  return existing
    .mapErr((cause) => clientConfigFailures.readFailed(target, cause))
    .andThen((current): SkillOutcome => {
      if (current !== null && !isPattyOwn(current)) return ok(leftUnchangedNotOwn(target));
      return readText(join(SKILLS_ROOT, pointer.packagedSkill, SKILL_FILE))
        .mapErr((cause) => clientConfigFailures.readFailed(join(SKILLS_ROOT, pointer.packagedSkill, SKILL_FILE), cause))
        .andThen((pointerText) =>
          writeText(target, pointerText).mapErr((cause) => clientConfigFailures.writeFailed(target, cause)),
        )
        .map(() => `  Installed skill: ${target}`);
    });
};

const removeFile = Result.fromThrowable((target: string, directory: string) => {
  rmSync(target);
  try {
    rmdirSync(directory);
  } catch {
    // The folder holds something else of the person's: it stays.
  }
}, R.identity());

const removeOne = (root: string, pointer: SkillPointer): SkillOutcome => {
  const target = fileOf(root, pointer);
  if (!existsSync(target)) return ok(`  No skill to remove: ${target} does not exist`);
  return readText(target)
    .mapErr((cause) => clientConfigFailures.readFailed(target, cause))
    .andThen((current): SkillOutcome => {
      if (!isPattyOwn(current)) return ok(leftUnchangedNotOwn(target));
      return removeFile(target, join(root, pointer.installDirectory))
        .mapErr((cause) => clientConfigFailures.writeFailed(target, cause))
        .map(() => `  Removed skill: ${target}`);
    });
};

const report = (outcomes: Result<string[], ClientConfigFailure>): ClientSetupResult =>
  outcomes.map((lines): ClientSetupReport => ({ warnings: [], lines }));

export const installSkills = (root: string): ClientSetupResult =>
  report(Result.combine(SKILL_POINTERS.map((pointer) => installOne(root, pointer))));

export const removeSkills = (root: string): ClientSetupResult =>
  report(Result.combine(SKILL_POINTERS.map((pointer) => removeOne(root, pointer))));
