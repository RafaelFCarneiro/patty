import type { Result } from 'neverthrow';
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

export type SkillPointer = { installDirectory: string; packagedSkill: string };

export const SKILL_POINTERS: readonly SkillPointer[] = [
  { installDirectory: 'patty-dashboard', packagedSkill: 'dashboard-building' },
  { installDirectory: 'patty-tour', packagedSkill: 'patty-tour' },
];

export const leftUnchangedNotOwn = (path: string): string => `  Left unchanged (not PATTY's own): ${path}`;

export const SKILL_POINTER_MARKER = '<!-- patty:skill-pointer -->';

export type SkillOutcome = Result<string, ClientConfigFailure>;

export type ClientLookup<Client> = { client: Client; exit?: undefined } | { client?: undefined; exit: number };
