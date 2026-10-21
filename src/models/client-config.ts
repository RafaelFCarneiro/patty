import { z } from 'zod';
import { reasonOf } from './error.js';

/** Why a client's configuration file could not be used (expected failures of `setup`). */
export const ClientConfigFailureCode = z.enum(['read_failed', 'write_failed']);
export type ClientConfigFailureCode = z.infer<typeof ClientConfigFailureCode>;

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
