import { DASHBOARD_PATH, httpOrigin, LOOPBACK_HOST } from '../../../common/net.js';
import { DEMO_PORT, DemoCountry, DemoFailureCode, DemoSeedStatus, type DemoFailure } from '../../../models/demo.js';
import { NPX_COMMAND } from '../../../models/package.js';
import { DEMO_FLAG, DEMO_POSITIONALS, DemoOptionsSchema } from '../../../wire/in/cli.js';
import { EXIT_OK, exitCodeOf, fail, parseFlags, type CliIo, type DemoPrepared } from '../io.js';

const RESET_FLAG = 'reset';
const COUNTRY_FLAG = 'country';
const DEMO_FLAGS = { [COUNTRY_FLAG]: { type: 'string' }, [RESET_FLAG]: { type: 'boolean' } } as const;

const dashboardUrl = (): string => `${httpOrigin(LOOPBACK_HOST, DEMO_PORT)}${DASHBOARD_PATH}`;
const RESET_HINT = `${NPX_COMMAND} demo --${RESET_FLAG}`;

export const DEMO_HELP = `
Usage: ${NPX_COMMAND} demo [--${COUNTRY_FLAG} ${DemoCountry.options.join('|')}] [--${RESET_FLAG}]

Seeds a throwaway demo database — sample data, never your finances — and serves its dashboards on port ${DEMO_PORT}
(your real FinTrack keeps its own database and port). No login: the demo is loopback-only and its key is public.

Options:
  --${COUNTRY_FLAG} <code>  the data set, and with it the language and currency: ${DemoCountry.options.join(', ')}
                    (default: your OS locale's country, else us)
  --${RESET_FLAG}           delete the demo database and seed it again; refuses any file that is not a demo database

To use it from an AI client: ${NPX_COMMAND} setup <client> --${DEMO_FLAG}
`.trimStart();

/** The words of each refusal. Exhaustive: a failure code without wording fails to compile. */
const FAILURE_MESSAGES = {
  [DemoFailureCode.enum.real_database]: () =>
    'the demo database path is the real database (DB_PATH), or cannot be resolved to a file — the demo never touches it',
  [DemoFailureCode.enum.not_demo]: () =>
    'the file at the demo database path is not a demo database (or does not open with the demo key), so it is left ' +
    'alone. Move it away if it is yours to remove',
  [DemoFailureCode.enum.interrupted]: () =>
    `the demo was not fully seeded (an earlier run stopped partway). Start it over with: ${RESET_HINT}`,
  [DemoFailureCode.enum.seed_failed]: ({ reason }: DemoFailure) =>
    `seeding the demo failed: ${reason}. A demo created by this run was removed; try again, or use --${RESET_FLAG}`,
  [DemoFailureCode.enum.start_failed]: ({ reason }: DemoFailure) => `the demo could not start: ${reason}`,
  [DemoFailureCode.enum.busy]: () =>
    'another demo run is preparing the same database right now (or died holding its lock file, which is cleared once ' +
    'that process is gone). Wait for it, then run this again',
  [DemoFailureCode.enum.port_in_use]: () =>
    `port ${DEMO_PORT} is already in use. If the demo is already running (an AI client's fintrack-demo server, or ` +
    `another "demo"), open ${dashboardUrl()}`,
} as const satisfies Record<DemoFailureCode, (failure: DemoFailure) => string>;

const failureMessage = (failure: DemoFailure): string => FAILURE_MESSAGES[failure.code](failure);

const seededNote = (prepared: DemoPrepared): string =>
  prepared.status === DemoSeedStatus.enum.seeded
    ? `Seeded a new demo (${prepared.country}).`
    : `The demo is already seeded (add --${RESET_FLAG} to start over, with --${COUNTRY_FLAG} to pick another data set).`;

export const DEMO_MESSAGES = {
  ready: (prepared: DemoPrepared): string =>
    [
      'FinTrack demo — sample data, not your finances. Do not enter real data here.',
      seededNote(prepared),
      `  Database:   ${prepared.databasePath} (encrypted with the published demo key)`,
      `  Dashboards: ${dashboardUrl()}   (Ctrl-C to stop)`,
      `Use it from an AI client: ${NPX_COMMAND} setup <client> --${DEMO_FLAG}`,
      `Ready for your own data? ${NPX_COMMAND} setup <client>`,
    ].join('\n'),
} as const;

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

export const runDemoCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  if (args.some((argument) => HELP_FLAGS.includes(argument))) {
    io.out(DEMO_HELP);
    return EXIT_OK;
  }
  const parsed = parseFlags(args, DEMO_FLAGS, DemoOptionsSchema, DEMO_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));

  const prepared = await io.demo.prepare(parsed.options);
  if (prepared.isErr()) return exitCodeOf(fail(io, failureMessage(prepared.error)));
  io.out(DEMO_MESSAGES.ready(prepared.value));

  const serving = await io.demo.serve();
  if (serving.isErr()) return exitCodeOf(fail(io, failureMessage(serving.error)));
  return EXIT_OK;
};
