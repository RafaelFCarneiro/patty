import { eq } from 'drizzle-orm';
import { errAsync, okAsync } from 'neverthrow';
import { hashPassword } from '../../../src/diplomat/auth/credentials.js';
import { promptEnded, type Terminal } from '../../../src/diplomat/cli/terminal.js';
import type { Db } from '../../../src/diplomat/db/driver.js';
import { users } from '../../../src/diplomat/db/schema.js';
import { KEY_EXPORT_CONFIRMATION_ANSWER } from '../../../src/models/auth/key-export.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';

/** What `key export` asks of a person: an administrator's login, then a confirmation. */
export const ADMIN = 'owner';
export const PASSWORD = 'correct horse battery staple';

export type Answers = { visible: string[]; secret: string[] };

/** The login and the confirmation, in the order `key export` asks for them. */
export const confirmedExport = (): Answers => ({
  visible: [ADMIN, KEY_EXPORT_CONFIRMATION_ANSWER],
  secret: [PASSWORD],
});

/** Gives the owner (an administrator, inserted by migration) the login `key export` verifies. */
export const claimOwner = async (db: Db): Promise<void> => {
  await db
    .update(users)
    .set({ username: ADMIN, passwordHash: await hashPassword(PASSWORD) })
    .where(eq(users.id, OWNER_USER_ID));
};

/** A person at the keyboard, answering from what `answers` holds when asked; running dry ends the prompt (Ctrl-D). */
export const terminalAnswering = (
  answers: () => Answers,
  tell: (message: string) => void = () => undefined,
): Terminal => {
  const next = (queue: string[]) => {
    const answer = queue.shift();
    return answer === undefined ? errAsync(promptEnded('cancelled')) : okAsync(answer);
  };
  return {
    ask: () => next(answers().visible),
    askSecret: () => next(answers().secret),
    tell,
    close: () => undefined,
  };
};
