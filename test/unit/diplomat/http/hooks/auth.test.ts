import { Writable } from 'node:stream';
import Fastify, { type InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { allowedOrigins } from '../../../../../src/diplomat/http/hooks/auth.js';
import { httpLoggerOptions } from '../../../../../src/server.js';

describe('allowedOrigins (CSRF)', () => {
  const PUBLIC = 'https://fintrack.example.com';

  it('is PUBLIC_URL when it is set and the request came in on the public host', () => {
    expect(allowedOrigins(PUBLIC, 'fintrack.example.com')).toEqual([PUBLIC]);
  });

  it("also allows the request's own loopback origin (a local operator on the port publish)", () => {
    expect(allowedOrigins(PUBLIC, '127.0.0.1:51737')).toEqual([PUBLIC, 'http://127.0.0.1:51737']);
    expect(allowedOrigins(undefined, 'localhost:3001')).toEqual(['http://localhost:3001']);
    expect(allowedOrigins(undefined, '[::1]:3001')).toEqual(['http://[::1]:3001']);
  });

  it('never derives an origin from a non-loopback Host — a rebinding attacker controls it', () => {
    expect(allowedOrigins(undefined, 'attacker.example')).toEqual([]);
    expect(allowedOrigins(undefined, '192.168.1.10:51737')).toEqual([]);
    expect(allowedOrigins(PUBLIC, 'attacker.example')).toEqual([PUBLIC]);
  });

  it('is empty without a Host header or with a malformed one', () => {
    expect(allowedOrigins(undefined, undefined)).toEqual([]);
    expect(allowedOrigins(undefined, 'a b')).toEqual([]);
    expect(allowedOrigins(undefined, '127.0.0.1.evil.example')).toEqual([]);
  });
});

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
