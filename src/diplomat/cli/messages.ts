import type { PasswordReset } from '../../models/auth/password.js';

/** What the command line says to the person who ran it. */
export const CLI_MESSAGES = {
  ownerClaimed: (username: string) =>
    `Owner claimed: "${username}". Log in to the dashboard (/ui) with this username and your password.`,
  alreadyClaimed: (username: string) => `FinTrack is already set up: the owner is "${username}".`,
  passwordReset: (reset: PasswordReset) => `Password reset for "${reset.username}".`,
  sessionsEnded: (count: number) => `Sessions ended: ${count}`,
  tokensRevoked: (count: number) => `Access tokens revoked: ${count}`,
  resetting: (username: string) => `Choose a new password for "${username}".`,
  failure: (reason: string) => `fintrack: ${reason}`,
  unexpectedArgument: (argument: string) => `unexpected argument "${argument}"`,
} as const;
