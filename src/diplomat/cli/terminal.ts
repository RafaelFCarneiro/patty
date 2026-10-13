import { err, ok, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PASSWORD_STDIN_FLAG } from '../../wire/in/cli.js';
import { text } from 'node:stream/consumers';

/** How a prompt ended without an answer: Ctrl-C, or the input closing (Ctrl-D). */
export const PromptEnd = z.enum(['interrupted', 'cancelled']);
export type PromptEnd = z.infer<typeof PromptEnd>;
export type PromptEnded = { code: 'prompt_ended'; how: PromptEnd };
export const promptEnded = (how: PromptEnd): PromptEnded => ({ code: 'prompt_ended', how });

/** A person at a keyboard, apart from `node:readline` so `prompt.ts` is testable without a pseudo-terminal. */
export type Terminal = {
  ask: (question: string) => ResultAsync<string, PromptEnded>;
  askSecret: (question: string) => ResultAsync<string, PromptEnded>;
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

/**
 * Prompts on stderr; a secret answer is swallowed by a muted stream. Ctrl-C ends the prompt as `interrupted`, Ctrl-D
 * as `cancelled`; both are answers, not exceptions. Ctrl-C between prompts takes effect at the next prompt: a step
 * already running (hashing, a claim) finishes — deliberately, so no write is cut in half.
 */
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
  const ended = new Promise<PromptEnded>((resolve) => {
    lines.once('close', () =>
      resolve(promptEnded(interrupted ? PromptEnd.enum.interrupted : PromptEnd.enum.cancelled)),
    );
  });
  lines.once('SIGINT', () => {
    interrupted = true;
    lines.close();
    process.stderr.write('\n');
  });
  const answer = (pending: Promise<string>): ResultAsync<string, PromptEnded> =>
    new ResultAsync(Promise.race([pending.then((line) => ok(line)), ended.then((end) => err(end))]));

  return {
    ask: (question) => answer(lines.question(question)),
    askSecret: (question) => {
      const pending = lines.question(question);
      muted = true;
      const secret = answer(pending);
      return new ResultAsync(
        Promise.resolve(secret).finally(() => {
          muted = false;
          if (!interrupted) process.stderr.write('\n');
        }),
      );
    },
    tell: printDiagnostic,
    close: () => lines.close(),
  };
};

export const readPasswordFromStdin = async (): Promise<string> => {
  if (isInteractive()) throw new Error(STDIN_IS_A_TERMINAL_MESSAGE);
  return (await text(process.stdin)).replace(TRAILING_NEWLINE, '');
};
