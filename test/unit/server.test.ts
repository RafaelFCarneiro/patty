import { Writable } from 'node:stream';
import Fastify, { type InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { httpLoggerOptions } from '../../src/server.js';

describe('request logging (ADR-033 §2)', () => {
  const SECRET = 'SECRETTOKEN';

  const captureLog = async (request: InjectOptions): Promise<string> => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
    const options = httpLoggerOptions(true);
    if (!options) throw new Error('logging should be enabled');
    const app = Fastify({ logger: { ...options, stream } });
    app.get('/probe', async (_req, reply) => reply.header('set-cookie', `s=${SECRET}`).send({ ok: true }));
    await app.inject(request);
    await app.close();
    return output;
  };

  it('never writes the cookie, authorization or set-cookie values into a request log line', async () => {
    const output = await captureLog({
      method: 'GET',
      url: '/probe',
      headers: { cookie: `fintrack_session=${SECRET}`, authorization: `Bearer ${SECRET}` },
    });
    expect(output).toContain('incoming request');
    expect(output).not.toContain(SECRET);
  });

  it('declares redaction for the three credential-bearing headers, whatever a serializer adds later', () => {
    const options = httpLoggerOptions(true);
    expect(options && options.redact.paths).toEqual([
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
    ]);
  });

  it('is off when the logger is disabled', () => {
    expect(httpLoggerOptions(false)).toBe(false);
  });
});
