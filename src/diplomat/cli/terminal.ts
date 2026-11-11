import { err, ok, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import { createInterface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';
import { PASSWORD_STDIN_FLAG } from '../../wire/in/cli.js';
import { text } from 'node:stream/consumers';

/** How a prompt ended without an answer: Ctrl-C, or the input closing (Ctrl-D). */
export const PromptEnd = z.enum(['interrupted', 'cancelled']);
export type PromptEnd = z.infer<typeof PromptEnd>;
/** Why asking a person failed: the prompt ended before an answer came, or the answer is not valid. */
export const PromptFailureCode = z.enum(['prompt_ended', 'invalid_answer']);
export type PromptFailureCode = z.infer<typeof PromptFailureCode>;

export type PromptEnded = { code: typeof PromptFailureCode.enum.prompt_ended; how: PromptEnd };
export const promptEnded = (how: PromptEnd): PromptEnded => ({ code: PromptFailureCode.enum.prompt_ended, how });
export type InvalidAnswer = { code: typeof PromptFailureCode.enum.invalid_answer; message: string };
export const invalidAnswer = (message: string): InvalidAnswer => ({
  code: PromptFailureCode.enum.invalid_answer,
  message,
});

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

/** Races a question against the prompt ending. A question on a closed interface rejects: that is the prompt having
 *  ended (Ctrl-C between prompts), not a crash. */
const answer = (ended: Promise<PromptEnded>, question: () => Promise<string>): ResultAsync<string, PromptEnded> => {
  const stopped = ended.then((end) => err(end));
  // `question` runs now, not on a later tick: the prompt text is written before a secret answer mutes the output.
  const pending = new Promise<string>((resolve, reject) => {
    question().then(resolve, reject);
  }).then(
    (line) => ok(line),
    () => stopped,
  );
  return new ResultAsync(Promise.race([pending, stopped]));
};

/** Where a terminal reads and prompts: the process's own stdin and stderr, unless a test hands it streams. */
export type TerminalStreams = { input: Readable; output: Writable };

/**
 * Prompts on stderr; a secret answer is swallowed by a muted stream. Ctrl-C ends the prompt as `interrupted`, Ctrl-D
 * as `cancelled`; both are answers, not exceptions. Ctrl-C between prompts takes effect at the next prompt: a step
 * already running (hashing, a claim) finishes — deliberately, so no write is cut in half.
 */
export const open = (streams: TerminalStreams = { input: process.stdin, output: process.stderr }): Terminal => {
  let muted = false;
  let interrupted = false;
  const output = new Writable({
    write: (chunk: Buffer, encoding, callback) => {
      if (!muted) streams.output.write(chunk, encoding);
      callback();
    },
  });
  const lines = createInterface({ input: streams.input, output, terminal: true });
  const ended = new Promise<PromptEnded>((resolve) => {
    lines.once('close', () =>
      resolve(promptEnded(interrupted ? PromptEnd.enum.interrupted : PromptEnd.enum.cancelled)),
    );
  });
  lines.once('SIGINT', () => {
    interrupted = true;
    lines.close();
    streams.output.write('\n');
  });
  return {
    ask: (question) => answer(ended, () => lines.question(question)),
    askSecret: (question) => {
      const secret = answer(ended, () => lines.question(question));
      muted = true; // after the prompt text is written, before anything is typed
      return new ResultAsync(
        Promise.resolve(secret).finally(() => {
          muted = false;
          if (!interrupted) streams.output.write('\n');
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
