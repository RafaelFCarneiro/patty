import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PASSWORD_STDIN_FLAG } from '../../common/cli.js';
import { text } from 'node:stream/consumers';

/** What the CLI needs from a person at a keyboard — kept apart from `node:readline` so the prompting rules in
 *  `prompt.ts` are testable without a pseudo-terminal. */
export type Terminal = {
  /** A visible question. */
  ask: (question: string) => Promise<string>;
  /** A question whose answer is never echoed. */
  askSecret: (question: string) => Promise<string>;
  /** A line for the person (stderr — stdout is reserved for results). */
  tell: (message: string) => void;
  close: () => void;
};

export const PROMPT_ABORTED_MESSAGE = 'cancelled';
export const STDIN_IS_A_TERMINAL_MESSAGE = `--${PASSWORD_STDIN_FLAG} expects the password piped or redirected in, but stdin is a terminal`;

const TRAILING_NEWLINE = /\r?\n$/;
const SIGINT_EXIT_CODE = 130;

/** A result line (stdout). */
export const printResult = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A diagnostic line (stderr). */
export const printDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const isInteractive = (): boolean => process.stdin.isTTY === true;

/** Opens a prompt on the real terminal. Prompts go to stderr and the answer to a secret question is swallowed
 *  by a muted output stream, so it is never echoed. Ctrl-C ends the process; Ctrl-D rejects the pending question. */
export const openTerminal = (): Terminal => {
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
  // Closing on purpose (below) also rejects `closed`; nobody is racing it then.
  closed.catch(() => undefined);
  lines.once('SIGINT', () => {
    lines.close();
    process.stderr.write('\n');
    process.exit(SIGINT_EXIT_CODE);
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

/** The password piped on stdin (`--password-stdin`): everything up to the final newline. Length and shape are the
 *  caller's to validate. A terminal on stdin is refused rather than waited on. */
export const readPasswordFromStdin = async (): Promise<string> => {
  if (isInteractive()) throw new Error(STDIN_IS_A_TERMINAL_MESSAGE);
  return (await text(process.stdin)).replace(TRAILING_NEWLINE, '');
};
