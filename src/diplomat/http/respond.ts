import type { FastifyReply } from 'fastify';
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

export const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.output<S> | null => {
  const r = schema.safeParse(body);
  if (!r.success) {
    reply.status(422).send({ error: { code: 'validation', issues: r.error.issues.map((i) => i.message) } });
    return null;
  }
  return r.data as z.output<S>;
};

// Some query-param handlers (routes/account.ts, routes/category.ts) report a fixed generic
// message on a failed safeParse rather than `parse`'s per-field zod issues, since a query string
// is already loosely typed at that point. Shared here since the message is otherwise duplicated
// verbatim across those route modules.
const INVALID_QUERY_ISSUE = 'invalid query';
export const invalidQueryResponse = (reply: FastifyReply) =>
  reply.status(422).send({ error: { code: 'validation', issues: [INVALID_QUERY_ISSUE] } });

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
