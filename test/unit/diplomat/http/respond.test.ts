import type { FastifyReply, FastifyRequest } from 'fastify';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { notFound } from '../../../../src/models/error.js';
import {
  invalidQueryResponse,
  isConfirmed,
  parse,
  parseOrIssue,
  pathParam,
  replyError,
  send,
  sendUpsert,
  unprocessable,
} from '../../../../src/diplomat/http/respond.js';

const fakeReply = () => {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      sent.status = code;
      return reply;
    },
    send: (body: unknown) => {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
};

const requestWith = (parts: { params?: unknown; query?: unknown }) => parts as unknown as FastifyRequest;

const unknownAccount = () => notFound('account', 'Checking', []);

const Schema = z.object({ n: z.number() });

describe('the 422 reply shape', () => {
  it('unprocessable answers { error: { code: validation, issues } } with 422', () => {
    const { reply, sent } = fakeReply();
    unprocessable(reply, ['bad']);
    expect(sent).toEqual({ status: 422, body: { error: { code: 'validation', issues: ['bad'] } } });
  });

  it('parse returns the decoded value, or answers 422 with the per-field issues and returns null', () => {
    const ok_ = fakeReply();
    expect(parse(Schema, { n: 1 }, ok_.reply)).toEqual({ n: 1 });
    expect(ok_.sent).toEqual({});

    const bad = fakeReply();
    expect(parse(Schema, { n: 'x' }, bad.reply)).toBeNull();
    expect(bad.sent.status).toBe(422);
  });

  it('parseOrIssue answers one fixed issue instead of the zod messages', () => {
    const bad = fakeReply();
    expect(parseOrIssue(Schema, { n: 'x' }, bad.reply, 'invalid n')).toBeNull();
    expect(bad.sent).toEqual({ status: 422, body: { error: { code: 'validation', issues: ['invalid n'] } } });
    expect(parseOrIssue(Schema, { n: 2 }, fakeReply().reply, 'invalid n')).toEqual({ n: 2 });
  });

  it('invalidQueryResponse defaults to the generic query message', () => {
    const { reply, sent } = fakeReply();
    invalidQueryResponse(reply);
    expect(sent.body).toEqual({ error: { code: 'validation', issues: ['invalid query'] } });
  });
});

describe('result replies', () => {
  it('replyError answers the error’s HTTP status and { error }', () => {
    const { reply, sent } = fakeReply();
    replyError(reply, unknownAccount());
    expect(sent).toEqual({ status: 404, body: { error: unknownAccount() } });
  });

  it('send maps a failure to its HTTP status and a success to the given one', () => {
    const failed = fakeReply();
    send(failed.reply, err(unknownAccount()));
    expect(failed.sent.status).toBe(404);

    const created = fakeReply();
    send(created.reply, ok({ id: 'a' }), 201);
    expect(created.sent).toEqual({ status: 201, body: { id: 'a' } });
  });

  it('sendUpsert answers 201 for a created write and 200 for an idempotent replay', () => {
    const created = fakeReply();
    sendUpsert(created.reply, ok({ created: true }));
    expect(created.sent.status).toBe(201);

    const replay = fakeReply();
    sendUpsert(replay.reply, ok({ created: false }));
    expect(replay.sent.status).toBe(200);
  });

  it('sendUpsert maps a failure to its HTTP status', () => {
    const failed = fakeReply();
    sendUpsert(failed.reply, err(unknownAccount()));
    expect(failed.sent.status).toBe(404);
  });
});

describe('request readers', () => {
  it('pathParam reads :name / :id', () => {
    expect(pathParam(requestWith({ params: { name: 'Checking' } }), 'name')).toBe('Checking');
    expect(pathParam(requestWith({ params: { id: 'tx-1' } }), 'id')).toBe('tx-1');
  });

  it('isConfirmed is true only for ?confirm=true', () => {
    expect(isConfirmed(requestWith({ query: { confirm: 'true' } }))).toBe(true);
    expect(isConfirmed(requestWith({ query: { confirm: 'false' } }))).toBe(false);
    expect(isConfirmed(requestWith({ query: {} }))).toBe(false);
  });
});
