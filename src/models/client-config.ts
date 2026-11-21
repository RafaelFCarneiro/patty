import { z } from 'zod';
import { reasonOf } from './error.js';

/** Why a client's configuration file could not be used (expected failures of `setup`). */
export const ClientConfigFailureCode = z.enum(['read_failed', 'write_failed']);
export type ClientConfigFailureCode = z.infer<typeof ClientConfigFailureCode>;

/** What every refusal of an unusable client file says first, and last. */
export const INVALID_ROOT_MESSAGE = 'does not contain a JSON object at the root';
export const LEFT_UNCHANGED = ' — left unchanged';

export type ClientConfigFailure = {
  code: ClientConfigFailureCode;
  path: string;
  /** The underlying system's own words (`EISDIR: …`). */
  reason: string;
  /** Raised before the failure and still owed to the person, ahead of it. */
  warnings: readonly string[];
};

export const clientConfigFailures = {
  readFailed: (path: string, cause: unknown): ClientConfigFailure => ({
    code: ClientConfigFailureCode.enum.read_failed,
    path,
    reason: reasonOf(cause),
    warnings: [],
  }),
  writeFailed: (path: string, cause: unknown, warnings: readonly string[] = []): ClientConfigFailure => ({
    code: ClientConfigFailureCode.enum.write_failed,
    path,
    reason: reasonOf(cause),
    warnings,
  }),
};

/** A skill `setup` installs next to a client: the folder it goes in, and the packaged skill it is a copy of. */
export type SkillPointer = { directory: string; source: string };

/** The skills `setup claude-code` installs. Each is a pointer: its body says which tool returns the real guide. */
export const SKILL_POINTERS: readonly SkillPointer[] = [
  { directory: 'patty-dashboard', source: 'dashboard-building' },
  { directory: 'patty-tour', source: 'patty-tour' },
];

/** What setup says of a skill file that is not PATTY's own, whichever way it was asked to touch it. */
export const leftUnchangedNotOwn = (path: string): string => `  Left unchanged (not PATTY's own): ${path}`;

/** Marks a skill file as PATTY's own: `setup` replaces or removes only files that carry it, never a person's. */
export const SKILL_POINTER_MARKER = '<!-- patty:skill-pointer -->';
