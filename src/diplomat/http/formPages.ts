import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HTML_CONTENT_TYPE } from './uiFiles.js';

/** Server-rendered, form-posting pages (the sign-in pages and the token pages): one set of headers and one
 *  urlencoded parser, so no page can be a little less locked down than its neighbour. */

export const FORM_BODY_LIMIT_BYTES = 8 * 1024;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

// These pages are tiny, self-contained and framed by nobody: lock everything down (no scripts, no
// third-party loads, no embedding) and never let a proxy or the back button keep a copy.
const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
} as const;

export const page = (reply: FastifyReply, status: number, html: string): FastifyReply =>
  reply.status(status).headers(PAGE_HEADERS).type(HTML_CONTENT_TYPE).send(html);

// An urlencoded body is only parsed in the scopes that call `addFormParser` — never app-wide, so `/api` keeps
// rejecting it.
const parseFormBody = (_req: FastifyRequest, body: string, done: (err: Error | null, value?: unknown) => void) => {
  done(null, Object.fromEntries(new URLSearchParams(body)));
};

export const addFormParser = (scope: FastifyInstance): void =>
  scope.addContentTypeParser(FORM_CONTENT_TYPE, { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT_BYTES }, parseFormBody);
