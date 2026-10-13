import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PASSWORD_STDIN_FLAG } from '../../wire/in/cli.js';
import { text } from 'node:stream/consumers';

/** A person at a keyboard, apart from `node:readline` so `prompt.ts` is testable without a pseudo-terminal. */
export type Terminal = {
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
  tell: (message: string) => void;
  close: () => void;
};

export const PROMPT_ABORTED_MESSAGE = 'cancelled';

/** Ctrl-C at a prompt: the prompt is closed and the newline written; the command ends with `EXIT_INTERRUPTED`. */
export class PromptInterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'PromptInterruptedError';
  }
}
export const STDIN_IS_A_TERMINAL_MESSAGE = `--${PASSWORD_STDIN_FLAG} expects the password piped or redirected in, but stdin is a terminal`;

const TRAILING_NEWLINE = /\r?\n$/;

export const printResult = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const printDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const isInteractive = (): boolean => process.stdin.isTTY === true;

/** Prompts on stderr; a secret answer is swallowed by a muted stream. Ctrl-C rejects the question as interrupted,
 *  Ctrl-D as cancelled. Ctrl-C between prompts takes effect at the next prompt: a step already running (hashing, a
 *  claim) finishes — deliberately, so no write is cut in half. */
export const open = (): Terminal => {
  let muted = false;
  let interrupted = false;
  const output = new Writable({
    write: (chunk: Buffer, encoding, callback) => {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const lines = createInterface({ input: process.stdin, output, terminal: true });
  const closed = new Promise<never>((_resolve, reject) => {
    lines.once('close', () => reject(interrupted ? new PromptInterruptedError() : new Error(PROMPT_ABORTED_MESSAGE)));
  });
  closed.catch(() => undefined);
  lines.once('SIGINT', () => {
    interrupted = true;
    lines.close();
    process.stderr.write('\n');
  });

  return {
    ask: (question) => Promise.race([lines.question(question), closed]),
    askSecret: async (question) => {
      const answer = lines.question(question);
      muted = true;
      try {
        return await Promise.race([answer, closed]);
      } finally {
        muted = false;
        if (!interrupted) process.stderr.write('\n');
      }
    },
    tell: printDiagnostic,
    close: () => lines.close(),
  };
};

export const readPasswordFromStdin = async (): Promise<string> => {
  if (isInteractive()) throw new Error(STDIN_IS_A_TERMINAL_MESSAGE);
  return (await text(process.stdin)).replace(TRAILING_NEWLINE, '');
};
