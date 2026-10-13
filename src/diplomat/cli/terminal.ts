import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { EXIT_INTERRUPTED, PASSWORD_STDIN_FLAG } from '../../common/cli.js';
import { text } from 'node:stream/consumers';

/** A person at a keyboard, apart from `node:readline` so `prompt.ts` is testable without a pseudo-terminal. */
export type Terminal = {
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
  tell: (message: string) => void;
  close: () => void;
};

export const PROMPT_ABORTED_MESSAGE = 'cancelled';
export const STDIN_IS_A_TERMINAL_MESSAGE = `--${PASSWORD_STDIN_FLAG} expects the password piped or redirected in, but stdin is a terminal`;

const TRAILING_NEWLINE = /\r?\n$/;

export const printResult = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const printDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const isInteractive = (): boolean => process.stdin.isTTY === true;

/** Prompts on stderr; a secret answer is swallowed by a muted stream. Ctrl-C exits; Ctrl-D rejects the question. */
export const open = (): Terminal => {
  let muted = false;
  const output = new Writable({
    write: (chunk: Buffer, encoding, callback) => {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const lines = createInterface({ input: process.stdin, output, terminal: true });
  const closed = new Promise<never>((_resolve, reject) => {
    lines.once('close', () => reject(new Error(PROMPT_ABORTED_MESSAGE)));
  });
  closed.catch(() => undefined);
  lines.once('SIGINT', () => {
    lines.close();
    process.stderr.write('\n');
    process.exit(EXIT_INTERRUPTED);
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
        process.stderr.write('\n');
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
