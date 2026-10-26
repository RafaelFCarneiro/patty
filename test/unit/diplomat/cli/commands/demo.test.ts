import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../../../src/diplomat/cli/commands.js';
import type { CliIo, DemoPrepared, DemoRequest, DemoShell } from '../../../../../src/diplomat/cli/io.js';
import {
  DEMO_PORT,
  DemoCountry,
  demoFailures,
  DemoFailureCode,
  DemoSeedStatus,
  type DemoFailure,
} from '../../../../../src/models/demo.js';
import { unusedExporter } from '../../../fixtures/exporter.js';

const DATABASE_PATH = '/home/x/.fintrack/demo.db';
const PREPARED: DemoPrepared = {
  status: DemoSeedStatus.enum.seeded,
  databasePath: DATABASE_PATH,
  country: DemoCountry.enum.br,
};

const rig = (prepared: Result<DemoPrepared, DemoFailure>, served: Result<void, DemoFailure> = ok(undefined)) => {
  const out: string[] = [];
  const err: string[] = [];
  const prepare = vi.fn(async (_request: DemoRequest) => prepared);
  const serve = vi.fn(async () => served);
  const demo: DemoShell = { databasePath: DATABASE_PATH, hasDatabase: () => true, prepare, serve };
  const io = {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    exporter: unusedExporter,
    demo,
    openShell: () => {
      throw new Error('the demo opens no shell');
    },
  } as unknown as CliIo;
  return { io, out, err, prepare, serve };
};

describe('fintrack demo', () => {
  it('prepares the demo, says what it is and where the dashboards are, then serves', async () => {
    const { io, out, err, prepare, serve } = rig(ok(PREPARED));
    expect(await runCli(['demo'], io)).toBe(0);
    expect(prepare).toHaveBeenCalledWith({ country: undefined, reset: false });
    expect(serve).toHaveBeenCalledOnce();
    const text = out.join('\n');
    expect(text).toContain('sample data, not your finances');
    expect(text).toContain(DATABASE_PATH);
    expect(text).toContain(`http://127.0.0.1:${DEMO_PORT}/ui/overview`);
    expect(text).toContain('Seeded a new demo (br)');
    expect(text).toContain('setup <client> --demo');
    expect(err).toEqual([]);
  });

  it('prints before it serves, so the address is shown while the server stays up', async () => {
    const order: string[] = [];
    const { io, serve } = rig(ok(PREPARED));
    io.out = () => order.push('printed');
    serve.mockImplementation(async () => (order.push('served'), ok(undefined)));
    await runCli(['demo'], io);
    expect(order).toEqual(['printed', 'served']);
  });

  it('passes --country and --reset on', async () => {
    const { io, prepare } = rig(ok(PREPARED));
    expect(await runCli(['demo', '--country', 'co', '--reset'], io)).toBe(0);
    expect(prepare).toHaveBeenCalledWith({ country: DemoCountry.enum.co, reset: true });
  });

  it('says a demo that already existed is kept, and how to start over', async () => {
    const { io, out } = rig(ok({ ...PREPARED, status: DemoSeedStatus.enum.present }));
    expect(await runCli(['demo'], io)).toBe(0);
    expect(out.join('\n')).toContain('already seeded');
    expect(out.join('\n')).toContain('--reset');
  });

  it.each([
    [['demo', '--country', 'fr'], /--country must be one of: br, us, mx, co/],
    [['demo', 'extra'], /unexpected argument "extra"/],
    [['demo', '--nope'], /nope/],
  ])('refuses bad arguments (%j) before touching anything', async (args, message) => {
    const { io, err: errors, prepare } = rig(ok(PREPARED));
    expect(await runCli(args, io)).toBe(1);
    expect(errors.join('\n')).toMatch(message);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    [DemoFailureCode.enum.real_database, /real database \(DB_PATH\), or cannot be resolved/],
    [DemoFailureCode.enum.start_failed, /could not start: boom/],
    [DemoFailureCode.enum.not_demo, /not a demo database.*left alone/],
    [DemoFailureCode.enum.interrupted, /not fully seeded.*demo --reset/],
    [DemoFailureCode.enum.seed_failed, /seeding the demo failed: boom/],
  ])('%s: fails with its own message, and never serves', async (code, message) => {
    const { io, err: errors, serve } = rig(err(demoFailures.of(code, 'boom')));
    expect(await runCli(['demo'], io)).toBe(1);
    expect(errors.join('\n')).toMatch(message);
    expect(serve).not.toHaveBeenCalled();
  });

  it('a taken port is a failure that names the address the demo is probably already on', async () => {
    const { io, err: errors } = rig(ok(PREPARED), err(demoFailures.of(DemoFailureCode.enum.port_in_use)));
    expect(await runCli(['demo'], io)).toBe(1);
    expect(errors.join('\n')).toContain(`port ${DEMO_PORT} is already in use`);
    expect(errors.join('\n')).toContain(`http://127.0.0.1:${DEMO_PORT}/ui/overview`);
  });

  it('is in the usage listing', async () => {
    const { io, out } = rig(ok(PREPARED));
    await runCli(['--help'], io);
    expect(out.join('\n')).toMatch(/^ {2}demo /m);
  });
});
