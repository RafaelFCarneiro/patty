import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Result } from 'neverthrow';
import { z } from 'zod';
import { httpStatus, type AppError } from '../../common/errors.js';
import { ConfirmQuerySchema, IdParamSchema, NameParamSchema } from '../../wire/in/common.js';
import { ConflictErrorOut, NotFoundErrorOut, ValidationErrorOut } from '../../wire/out/errors.js';
import { okResponse } from './openapi.js';

/** Shared HTTP response helpers (ADR-025) — one implementation for every route module. */

export const send = <T>(reply: FastifyReply, result: Result<T, AppError>, okStatus = 200) =>
  result.match(
    (value) => reply.status(okStatus).send(value),
    (e) => reply.status(httpStatus(e)).send({ error: e }),
  );

/** The one 422 reply shape: `{ error: { code: 'validation', issues } }`. */
export const unprocessable = (reply: FastifyReply, issues: string[]) =>
  reply.status(422).send({ error: { code: 'validation', issues } });

export const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.output<S> | null => {
  const r = schema.safeParse(body);
  if (!r.success) {
    unprocessable(
      reply,
      r.error.issues.map((i) => i.message),
    );
    return null;
  }
  return r.data as z.output<S>;
};

// Some handlers report one fixed message on a failed safeParse rather than `parse`'s per-field zod issues, since a
// query string (or an optional body) is already loosely typed at that point.
const INVALID_QUERY_ISSUE = 'invalid query';
export const invalidQueryResponse = (reply: FastifyReply, issue = INVALID_QUERY_ISSUE) => unprocessable(reply, [issue]);

/** `parse`, but a failure answers with one fixed `issue` instead of the per-field zod messages. */
export const parseOrIssue = <S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  reply: FastifyReply,
  issue: string,
): z.output<S> | null => {
  const r = schema.safeParse(input);
  if (!r.success) {
    invalidQueryResponse(reply, issue);
    return null;
  }
  return r.data as z.output<S>;
};

/** 201 when the write created something, 200 on an idempotent replay. */
export const sendUpsert = <T extends { created: boolean }>(reply: FastifyReply, result: Result<T, AppError>) =>
  result.match(
    (value) => reply.status(value.created ? 201 : 200).send(value),
    (e) => reply.status(httpStatus(e)).send({ error: e }),
  );

/** A route's `:name` / `:id` path parameter. */
export const pathParam = (req: FastifyRequest, key: 'name' | 'id'): string =>
  (req.params as Record<typeof key, string>)[key];

/** `?confirm=true` — the opt-in that turns a destructive route's dry-run preview into the real thing. */
export const isConfirmed = (req: FastifyRequest): boolean => (req.query as { confirm?: string }).confirm === 'true';

// OpenAPI response-config shorthands, reused across route modules — composed here (not in
// openapi.ts) because they're built from wire/out/errors.js schemas, and openapi.ts stays
// domain/wire-agnostic (routing + doc-generation mechanics only).
export const validation422 = okResponse('Validation error', ValidationErrorOut);
export const notFound404 = okResponse('Not found', NotFoundErrorOut);
export const conflict409 = okResponse('Conflict', ConflictErrorOut);
export const nameParam = NameParamSchema;
export const idParam = IdParamSchema;
export const confirmQuery = ConfirmQuerySchema;

// Shared by /ui/:name (routes/dashboard.ts) and /api/openapi.json (routes.ts) — both must never
// be masked by a stale browser copy.
export const CACHE_CONTROL_NO_CACHE = 'no-cache';
