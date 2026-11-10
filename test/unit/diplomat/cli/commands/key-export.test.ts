import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, errAsync, ok, okAsync, type ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../../../src/diplomat/cli/commands.js';
import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, type CliIo } from '../../../../../src/diplomat/cli/io.js';
import { CLI_MESSAGES } from '../../../../../src/diplomat/cli/messages.js';
import { MAX_PROMPT_ATTEMPTS, PROMPT_MESSAGES } from '../../../../../src/diplomat/cli/prompt.js';
import {
  promptEnded,
  type PromptEnd,
  type PromptEnded,
  type Terminal,
} from '../../../../../src/diplomat/cli/terminal.js';
import { KEY_EXPORT_CONFIRMATION_ANSWER, STEP_UP_RETRY_DELAY_MS } from '../../../../../src/models/auth/key-export.js';
import { AUTH_MESSAGES } from '../../../../../src/models/auth/message.js';
import type { UserEntity } from '../../../../../src/models/auth/owner.js';
import { PRIVATE_FILE_MODE } from '../../../../../src/models/export.js';
import { unusedDemo } from '../../../fixtures/demo.js';
import { unusedImporter } from '../../../fixtures/exporter.js';
import { adminFixture, unclaimedFixture, userFixture } from '../../../fixtures/users.js';

const KEY = 'c3'.repeat(32);
const PASSWORD = 'correct horse battery staple';
const WRONG = 'not the password at all';

type Answer = string | PromptEnd;
type Script = { visible?: Answer[]; secret?: Answer[] };

const answerOf = (queue: Answer[]): ResultAsync<string, PromptEnded> => {
  const next = queue.shift();
  if (next === undefined) throw new Error('the script ran out of answers — the command asked more than expected');
  return next === 'interrupted' || next === 'cancelled' ? errAsync(promptEnded(next)) : okAsync(next);
};

let root = '';
let dataDirectory = '';
let outputDirectory = '';
let out: string[] = [];
let err_: string[] = [];
let told: string[] = [];
let asked: string[] = [];
let waits: number[] = [];
let terminalClosed = false;

const terminalFor = (script: Script): Terminal => {
  const visible = [...(script.visible ?? [])];
  const secret = [...(script.secret ?? [])];
  return {
    ask: (question) => (asked.push(question), answerOf(visible)),
    askSecret: (question) => (asked.push(question), answerOf(secret)),
    tell: (message) => void told.push(message),
    close: () => void (terminalClosed = true),
  };
};

const USERS: UserEntity[] = [
  adminFixture('root'),
  userFixture('ana'),
  adminFixture('gone', { disabledAt: '2026-02-01T00:00:00.000Z' }),
];

const rig = (options: { terminal: Terminal | null; users?: UserEntity[] }) => {
  const { terminal, users = USERS } = options;
  const verifyPassword = vi.fn(async (hash: string, password: string) => hash === 'hash' && password === PASSWORD);
  const io: CliIo = {
    openShell: () => {
      throw new Error('key export opens no shell');
    },
    openTerminal: () => terminal,
    readPasswordFromStdin: async () => {
      throw new Error('key export reads no password from stdin');
    },
    out: (line) => void out.push(line),
    err: (line) => void err_.push(line),
    version: '0.0.0-test',
    wait: async (ms) => void waits.push(ms),
    interruptSignal: () => new AbortController().signal,
    clients: { find: () => undefined },
    exporter: {
      databasePath: () => join(dataDirectory, 'patty.db'),
      provenKey: async () => ok(KEY),
      writeSnapshot: async () => err('unused'),
      users: async () => ok(users),
      stepUpSecrets: async () => ({ verifyPassword, dummyPasswordHash: 'dummy' }),
    },
    importer: unusedImporter,
    demo: unusedDemo,
  };
  return { io, verifyPassword };
};

const keyFile = () => join(outputDirectory, 'patty_db_key');
const everythingShown = () => JSON.stringify([out, err_, told, asked]);
const YES = KEY_EXPORT_CONFIRMATION_ANSWER;

const exportWith = (script: Script, options: { users?: UserEntity[]; args?: string[] } = {}) => {
  const { io, verifyPassword } = rig({ terminal: terminalFor(script), users: options.users });
  const args = options.args ?? ['key', 'export', '--to', keyFile()];
  return runCli(args, io).then((exit) => ({ exit, verifyPassword }));
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'patty-key-export-')));
  dataDirectory = join(root, 'data');
  outputDirectory = join(root, 'out');
  mkdirSync(dataDirectory);
  mkdirSync(outputDirectory);
  out = [];
  err_ = [];
  told = [];
  asked = [];
  waits = [];
  terminalClosed = false;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('key export without a terminal', () => {
  it('is refused before anything is opened or asked, and writes nothing', async () => {
    const { io } = rig({ terminal: null });
    expect(await runCli(['key', 'export', '--to', keyFile()], io)).toBe(EXIT_FAILURE);
    expect(err_).toEqual([CLI_MESSAGES.failure(CLI_MESSAGES.keyExportNeedsTerminal)]);
    expect(asked).toEqual([]);
    expect(existsSync(keyFile())).toBe(false);
  });

  it('has no --password-stdin: it is an unknown flag, whether or not there is a terminal', async () => {
    for (const terminal of [null, terminalFor({})]) {
      const { io } = rig({ terminal });
      expect(await runCli(['key', 'export', '--password-stdin', '--to', keyFile()], io)).toBe(EXIT_FAILURE);
      expect(err_.join('\n')).toContain('--password-stdin');
      expect(err_.join('\n')).not.toContain(CLI_MESSAGES.keyExportNeedsTerminal);
      expect(asked).toEqual([]);
      err_ = [];
    }
    expect(existsSync(keyFile())).toBe(false);
  });
});

describe('key export before any prompt', () => {
  it('refuses a bad destination without asking anything', async () => {
    const { exit } = await exportWith({}, { args: ['key', 'export', '--to', join(dataDirectory, 'patty_db_key')] });
    expect(exit).toBe(EXIT_FAILURE);
    expect(err_.join('\n')).toContain('never sit next to the data');
    expect(asked).toEqual([]);
    expect(terminalClosed).toBe(true);
  });

  it('points to setup, asking nothing, while no administrator has a login', async () => {
    const users = [unclaimedFixture('user-owner', { role: 'admin' }), userFixture('ana')];
    const { exit } = await exportWith({}, { users });
    expect(exit).toBe(EXIT_FAILURE);
    expect(err_).toEqual([CLI_MESSAGES.failure(CLI_MESSAGES.keyExportStopped({ code: 'owner_unclaimed' }))]);
    expect(err_.join('\n')).toContain('auth setup');
    expect(asked).toEqual([]);
    expect(existsSync(keyFile())).toBe(false);
  });
});

describe('key export step-up', () => {
  it('writes the key after the right password and a confirmation: 0600, key and newline, printed nowhere', async () => {
    const { exit } = await exportWith({ visible: ['Root', YES], secret: [PASSWORD] });
    expect(exit).toBe(EXIT_OK);
    expect(readFileSync(keyFile(), 'utf8')).toBe(`${KEY}\n`);
    expect(statSync(keyFile()).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    expect(out).toEqual([CLI_MESSAGES.keyExported(keyFile())]);
    expect(everythingShown()).not.toContain(KEY);
    expect(told).toEqual([CLI_MESSAGES.keyExportWarning(keyFile())]);
    expect(asked).toEqual([PROMPT_MESSAGES.username, PROMPT_MESSAGES.password, PROMPT_MESSAGES.exportConfirmation]);
    expect(waits).toEqual([]);
    expect(terminalClosed).toBe(true);
  });

  it('accepts the right password after a wrong one, pausing in between', async () => {
    const { exit } = await exportWith({ visible: ['root', 'root', YES], secret: [WRONG, PASSWORD] });
    expect(exit).toBe(EXIT_OK);
    expect(readFileSync(keyFile(), 'utf8')).toBe(`${KEY}\n`);
    expect(waits).toEqual([STEP_UP_RETRY_DELAY_MS]);
    expect(told[0]).toBe(AUTH_MESSAGES.invalidCredentials);
  });

  it('stops after the allowed attempts, pausing between them, with nothing written', async () => {
    const wrong = Array.from({ length: MAX_PROMPT_ATTEMPTS }, () => WRONG);
    const { exit, verifyPassword } = await exportWith({ visible: wrong.map(() => 'root'), secret: wrong });
    expect(exit).toBe(EXIT_FAILURE);
    expect(existsSync(keyFile())).toBe(false);
    expect(waits).toEqual(Array.from({ length: MAX_PROMPT_ATTEMPTS - 1 }, () => STEP_UP_RETRY_DELAY_MS));
    expect(verifyPassword).toHaveBeenCalledTimes(MAX_PROMPT_ATTEMPTS);
    expect(asked).not.toContain(PROMPT_MESSAGES.exportConfirmation);
    expect(err_).toEqual([CLI_MESSAGES.failure(CLI_MESSAGES.keyExportStopped({ code: 'invalid_credentials' }))]);
  });

  it.each([
    ['a wrong password', 'root', WRONG],
    ['an unknown user', 'nobody', PASSWORD],
    ['a username too short to be one', 'x', PASSWORD],
    ['a member with the right password', 'ana', PASSWORD],
    ['a disabled administrator with the right password', 'gone', PASSWORD],
  ])('says the same neutral thing for %s, at the same cost, on every attempt', async (_label, username, password) => {
    const attempts = Array.from({ length: MAX_PROMPT_ATTEMPTS });
    const { exit, verifyPassword } = await exportWith({
      visible: attempts.map(() => username),
      secret: attempts.map(() => password),
    });
    expect(exit).toBe(EXIT_FAILURE);
    expect(told).toEqual(Array.from({ length: MAX_PROMPT_ATTEMPTS - 1 }, () => AUTH_MESSAGES.invalidCredentials));
    expect(err_).toEqual([CLI_MESSAGES.failure(CLI_MESSAGES.keyExportStopped({ code: 'invalid_credentials' }))]);
    expect(verifyPassword).toHaveBeenCalledTimes(MAX_PROMPT_ATTEMPTS);
    expect(existsSync(keyFile())).toBe(false);
  });
});

describe('key export confirmation and interruption', () => {
  it.each(['no', '', 'y', 'yes please'])('writes nothing when the answer is %j', async (answer) => {
    const { exit } = await exportWith({ visible: ['root', answer], secret: [PASSWORD] });
    expect(exit).toBe(EXIT_FAILURE);
    expect(existsSync(keyFile())).toBe(false);
    expect(err_).toEqual([CLI_MESSAGES.failure(CLI_MESSAGES.keyExportStopped({ code: 'export_declined' }))]);
    expect(told).toEqual([CLI_MESSAGES.keyExportWarning(keyFile())]);
  });

  it('Ctrl-C at the password ends as interrupted with nothing written', async () => {
    const { exit } = await exportWith({ visible: ['root'], secret: ['interrupted'] });
    expect(exit).toBe(EXIT_INTERRUPTED);
    expect(existsSync(keyFile())).toBe(false);
    expect(terminalClosed).toBe(true);
  });

  it('Ctrl-C at the confirmation ends as interrupted with nothing written', async () => {
    const { exit } = await exportWith({ visible: ['root', 'interrupted'], secret: [PASSWORD] });
    expect(exit).toBe(EXIT_INTERRUPTED);
    expect(existsSync(keyFile())).toBe(false);
  });

  it('Ctrl-D at the password is a failure that says it was cancelled, with nothing written', async () => {
    const { exit } = await exportWith({ visible: ['root'], secret: ['cancelled'] });
    expect(exit).toBe(EXIT_FAILURE);
    expect(err_).toEqual([CLI_MESSAGES.failure('cancelled')]);
    expect(existsSync(keyFile())).toBe(false);
  });
});

describe('key export when the database cannot be read', () => {
  it('says why and writes nothing', async () => {
    const { io } = rig({ terminal: terminalFor({}) });
    io.exporter.users = async () => err('there is no database at /nowhere');
    expect(await runCli(['key', 'export', '--to', keyFile()], io)).toBe(EXIT_FAILURE);
    expect(err_.join('\n')).toContain('there is no database at /nowhere');
    expect(asked).toEqual([]);
    expect(existsSync(keyFile())).toBe(false);
  });
});
