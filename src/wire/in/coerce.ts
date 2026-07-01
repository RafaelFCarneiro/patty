import { z } from 'zod';

export const coerceToNumber = (v: unknown) => (typeof v === 'string' ? Number(v) : v);

// Bare regex (no custom message) — matches the inline checks previously duplicated across
// diplomat/http/routes.ts query/body validators, now a single named schema they and the
// OpenAPI spec (diplomat/http/openapi.ts) both derive from.
export const IsoDateQuerySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
